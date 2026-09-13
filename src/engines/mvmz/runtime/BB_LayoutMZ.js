// ============================================================================
// BB_LayoutMZ.js —— RPG Maker MZ 排版回填插件（横向折行）
// ============================================================================
// 给 MZ 补上横向自动折行，让换语言后变长的文本能在窗口里正常断开。
//
// ── ★★ 千万不要直接套用 MV 版（BB_Layout.js）★★ ──
//   MZ 的绘制模型和 MV **完全不同**，两边的插件互不通用：
//
//   | | MV | MZ |
//   |---|---|---|
//   | 逐字入口 | `processNormalCharacter`（**MZ 里没有这个函数**） | 无此函数 |
//   | 绘制方式 | 一个字符一次 `drawText` | **累积到 `textState.buffer`，成段 `flushTextState`** |
//   | 控制符处理 | 在 `processCharacter` 的 switch 里 | `charCodeAt(0) < 0x20` 分流到 `processControlCharacter` |
//   | 行首基准 | `textState.left` | `textState.startX`（**没有 left**） |
//   | `processNewLine` | 内部有 `index++`（为消费 `\n` 设计）→ 直接调会**吃字** | **不动 index** → 可以直接调 |
//   | 构造签名 | `new Window_Message()` | `new Window_Message(rect)`（不传 Rectangle 会抛） |
//   | 字体来源 | `Window_Base.standardFontSize/Face` + `$dataSystem.locale` | `$gameSystem.mainFontSize()/mainFontFace()` |
//   | 消息窗宽 | 由插件决定（实测 640，`contents` 604） | `Graphics.boxWidth` **满宽**（实测 1892，`contents` 1868） |
//
// ── 实测结论：MZ 与 MV 的风险点不一样 ──
//   MV（实测 contents 604px、字号 24、每字 24px）：**每行只放 25.17 字**，
//       原文自身 7.2% 超行 —— 消息对白是重灾区，折行是刚需。
//   MZ（实测 contents 1868px、字号 26、每字 26px）：**每行放 71.85 字**，
//       实测该游戏 8334 条对白**超行 0 条（0.00%）** —— 消息窗根本不是问题。
//       但**窄窗**（1/2 宽 2.77%、1/3 宽 20.93%）会超行 —— 帮助栏/道具说明/状态栏
//       才是 MZ 上折行的价值所在。
//   ⇒ 所以这个插件在 MZ 上的定位是"**保护窄窗**"，而不是"救消息对白"。
//
// ── 拦截点：`Window_Base.prototype.processCharacter` ──
//   理由与 MV 相同：它是所有多行文本的必经之路，且宽度信息就在手边
//   （`this.contents.width` —— **每个窗口实例自己的宽度**，MZ 上尤其重要，
//     因为满宽消息窗和 1/3 宽状态栏差了三倍）。
//
// ── 换行怎么插入（MZ 版，和 MV 相反）──
//   MZ 的 `processNewLine` 只做三件事：
//       textState.x = textState.startX;
//       textState.y += textState.height;
//       textState.height = this.calcTextHeight(textState);
//   **完全不碰 index** —— 所以在 MZ 里**可以直接调用它**来换行，不会丢字。
//   （MV 那边必须往文本里插 `\n`，因为 MV 的 processNewLine 会 index++。）
//
//   还有一点 MZ 独有的便利：当前行的字**还在 buffer 里、尚未画出来**，
//   所以"避头点"要求的"把上一个字一起挪到下一行"是可以真做到的 ——
//   把 buffer 末字取下来、换行后再放回新行的 buffer 即可。
//   （MV 在同一时机已经画过了，没法收回，只能靠前瞻。）
/* eslint-disable */
(function () {
    'use strict';

    var PLUGIN_NAME = 'BB_LayoutMZ';
    var params = (window.PluginManager && PluginManager.parameters)
        ? PluginManager.parameters(PLUGIN_NAME) : {};

    function toBool(v, dflt) {
        if (v === undefined || v === null || v === '') return dflt;
        return String(v).toLowerCase() !== 'false' && String(v) !== '0';
    }

    // ── 中文标点禁则（与 native/common/wrap.h 同一套规则）──
    var LINE_START_FORBIDDEN = {};
    ('，。、；：？！）】》」』〕〉｝…—”’％℃｡､･｣ー').split('').forEach(function (c) {
        LINE_START_FORBIDDEN[c] = true;
    });
    var LINE_END_FORBIDDEN = {};
    ('（【《「『〔〈｛“‘＄￥＃').split('').forEach(function (c) {
        LINE_END_FORBIDDEN[c] = true;
    });

    var BB = {
        version: 1,
        engine: 'MZ',
        enabled: toBool(params.Enabled, true),
        stats: {
            processCharacterCalls: 0,
            wrapsInserted: 0,
            textsWrapped: 0,
            maxLineExtentSeen: 0,
            overflowsSeen: 0,
        },
        reports: [],
        maxReports: 50,
    };
    window.BB_Layout = BB;   // 与 MV 版用同一个全局名，验收脚本可以共用

    BB.isLineStartForbidden = function (c) { return !!LINE_START_FORBIDDEN[c]; };
    BB.isLineEndForbidden = function (c) { return !!LINE_END_FORBIDDEN[c]; };

    // ── 安装 ──
    var _processCharacter = Window_Base.prototype.processCharacter;
    var _flushTextState = Window_Base.prototype.flushTextState;

    /**
     * 包住 flushTextState：记录"这一行画到了多宽"。
     *
     * ★ 为什么要在这里记，而不是像 MV 那样在 processNewLine 里记：
     *   MZ 一行可能 **flush 多次**（遇到空格、控制符都会 flush），
     *   所以"一行"不等于"一次 flush"。这里按"相对行首的右边界"取最大值，
     *   才是判断"有没有超出 contents.width"的正确口径。
     *
     * 位置：必须在**原函数推进 x 之前**读 `textState.x`（那是本段文本的左边缘）。
     */
    Window_Base.prototype.flushTextState = function (textState) {
        var rep = this._bbReport;
        if (rep && BB.enabled && textState && textState.drawing !== false && !textState.rtl) {
            var w = this.textWidth(textState.buffer);
            // 本行目前的右边界（相对行首）= 本段左边缘 + 本段宽 − 行首
            var extent = textState.x + w - textState.startX;
            if (extent > rep.maxLineExtent) rep.maxLineExtent = extent;
            if (extent > BB.stats.maxLineExtentSeen) BB.stats.maxLineExtentSeen = extent;
            if (extent > this.contents.width + 0.5) BB.stats.overflowsSeen++;
        }
        return _flushTextState.apply(this, arguments);
    };

    Window_Base.prototype.processCharacter = function (textState) {
        if (BB.enabled && textState && textState.drawing !== false && textState.buffer !== undefined) {
            BB.stats.processCharacterCalls++;
            var c = textState.text[textState.index];
            // 只对"可见字符"做折行判断；控制符（<0x20）交给原逻辑
            if (c !== undefined && c.charCodeAt(0) >= 0x20) {
                var bufferLen = textState.buffer.length;
                // 行内已经有字才谈得上换行
                if (bufferLen > 0) {
                    var w = this.textWidth(textState.buffer + c);
                    if (w > this.contents.width) {
                        // ── 要换行了。先处理"避头点"：──
                        //   若 c 是不能放行首的收尾类标点，就把 buffer 末字
                        //   一起挪到下一行（此刻它还只在 buffer 里、没画出来，
                        //   所以**真的挪得动** —— 这是 MZ 缓冲模型给的好处）
                        var carry = '';
                        if (LINE_START_FORBIDDEN[c] && bufferLen > 1) {
                            carry = textState.buffer.charAt(bufferLen - 1);
                            textState.buffer = textState.buffer.slice(0, -1);
                        }
                        // 记下"断行前的行尾字符"与"新行的行首字符" —— 验收要靠它断言禁则
                        var lastDrawn = textState.buffer.charAt(textState.buffer.length - 1);
                        this.flushTextState(textState);   // 画完当前行
                        this.processNewLine(textState);   // 换行（MZ 里它不动 index，安全）
                        if (carry) textState.buffer += carry;
                        var rep0 = this._bbReport;
                        if (rep0) {
                            if (!rep0.wrapEnds) { rep0.wrapEnds = []; rep0.wrapStarts = []; }
                            rep0.wrapEnds.push(lastDrawn);
                            rep0.wrapStarts.push(carry ? carry : c);
                        }
                        BB.stats.wrapsInserted++;
                    } else if (LINE_END_FORBIDDEN[c] && bufferLen > 0) {
                        // ── 避尾点：当前字是不能放行尾的开括号类 ──
                        //   若它和下一段一起放不下，也提前换行
                        var nxt = textState.text[textState.index + 1];
                        if (nxt !== undefined && nxt.charCodeAt(0) >= 0x20) {
                            var w2 = this.textWidth(textState.buffer + c + nxt);
                            if (w2 > this.contents.width) {
                                var lastDrawn2 = textState.buffer.charAt(textState.buffer.length - 1);
                                this.flushTextState(textState);
                                this.processNewLine(textState);
                                var rep1 = this._bbReport;
                                if (rep1) {
                                    if (!rep1.wrapEnds) { rep1.wrapEnds = []; rep1.wrapStarts = []; }
                                    rep1.wrapEnds.push(lastDrawn2);
                                    rep1.wrapStarts.push(c);
                                }
                                BB.stats.wrapsInserted++;
                            }
                        }
                    }
                }
            }
        }
        return _processCharacter.apply(this, arguments);
    };

    /**
     * 包住 drawTextEx：开逐行报告。MZ 的 drawTextEx 与 MV 名字相同。
     */
    var _drawTextEx = Window_Base.prototype.drawTextEx;
    Window_Base.prototype.drawTextEx = function (text, x, y) {
        if (!BB.enabled) return _drawTextEx.apply(this, arguments);
        var rep = {
            engine: 'MZ',
            contentsWidth: this.contents.width,
            left: x,
            fontSize: this.contents.fontSize,
            fontFace: this.contents.fontFace,
            maxLineExtent: 0,
            wrapsBefore: BB.stats.wrapsInserted,
            textLength: text ? text.length : 0,
            used: false,
        };
        var prev = this._bbReport;
        this._bbReport = rep;
        try {
            return _drawTextEx.apply(this, arguments);
        } finally {
            this._bbReport = prev;
            rep.wrapsInThisCall = BB.stats.wrapsInserted - rep.wrapsBefore;
            if (rep.wrapsInThisCall > 0) {
                rep.used = true;
                BB.stats.textsWrapped++;
                BB.reports.push(rep);
                if (BB.reports.length > BB.maxReports) BB.reports.shift();
            }
        }
    };

    // ── 插件命令 / 外部开关（与 MV 版语义一致，供"一键还原"验证）──
    if (window.Game_Interpreter) {
        var _origPluginCommand = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command === 'BBLayoutMZ' || command === 'BBLayout') {
                var sub = ((args && args[0]) || '').toString().toLowerCase();
                if (sub === 'on') { BB.enabled = true; return; }
                if (sub === 'off') { BB.enabled = false; return; }
                if (sub === 'stat') { console.log('[BB_LayoutMZ] ' + JSON.stringify(BB.stats)); return; }
            }
            return _origPluginCommand.apply(this, arguments);
        };
    }
    BB.setEnabled = function (on) { BB.enabled = !!on; return BB.enabled; };
    BB.resetStats = function () {
        BB.stats = {
            processCharacterCalls: 0, wrapsInserted: 0, textsWrapped: 0,
            maxLineExtentSeen: 0, overflowsSeen: 0,
        };
        BB.reports = [];
    };

    try {
        console.log('[BB_LayoutMZ] 已装载：engine=MZ enabled=' + BB.enabled +
                    ' contents.width=' + (new Window_Message(new Rectangle(0, 0, Graphics.boxWidth, 200))).contents.width);
    } catch (e) {
        try { console.log('[BB_LayoutMZ] 已装载：enabled=' + BB.enabled); } catch (e2) {}
    }
})();
