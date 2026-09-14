// ============================================================================
// BB_Layout.js —— RPG Maker MV 排版回填插件（横向折行）
// ============================================================================
// 作用：给 MV 补上它**本来就没有**的横向自动折行，让换语言后变长的文本
//       能在窗口里正常断开，而不是冲出右边界被裁掉。
//
// ── 为什么必须做（实测依据）──
//   MV 原版**没有**横向折行：
//     · Window_Base.processNormalCharacter 只做 textState.x += w，没有宽度判断
//     · Window_Message.needsNewPage 只判**垂直**溢出
//     · 全文件无折行代码；视觉换行来自数据结构（Game_Message.allText = _texts.join('\n')）
//   实测该游戏：消息窗宽 640 → contents.width = 604，字号 24px，每字 24px
//   ⇒ **每行只能放 25.17 个全角字**；原文自身就有 7.2% 的对白超过这个宽度。
//
// ── 拦截点为什么选 processCharacter ──
//   1. 它是所有多行文本的必经之路（drawTextEx → processCharacter → …）
//   2. 宽度信息就在手边：textState.x（当前笔位）、textState.left（行首）、
//      this.contents.width（该窗口自己的可用宽）—— **按窗口取宽度**，
//      不用全局常量（战斗日志、帮助栏、状态栏宽度各不相同）
//   3. 度量与渲染同源：this.textWidth() → Bitmap.measureTextWidth → ctx.measureText
//
// ── ★ 换行怎么"插"进去（这一步最容易做错）──
//   不能像 YEP_MessageCore 那样直接调 processNewLine：
//     Window_Base.prototype.processNewLine 里有一句 `textState.index++`
//     —— 它是为"消费掉那个 \n 字符"设计的。中文没有空格可供消费，
//     直接调它会把**当前这个字**当成换行符吃掉，导致**丢字**。
//   （YEP 只在中英"空格处"折行，正好用 index++ 抵掉空格，所以它没暴露这个问题。）
//
//   正确做法：**往 textState.text 里插一个真的 '\n'**，然后交回原函数。
//     原 processCharacter 会看到 '\n' → 走 processNewLine → index++ 消费掉它。
//     字符一个不多、一个不少。
//
// ── 只读保证 ──
//   本插件不改引擎文件（rpg_*.js 一个字节不动），只包一层函数。
//   卸载 = 从 plugins.js 移除 + 删掉本文件；运行时关闭 = 插件命令 BBLayout off。
/* eslint-disable */
(function () {

    var PLUGIN_NAME = 'BB_Layout';
    var params = (window.PluginManager && PluginManager.parameters)
        ? PluginManager.parameters(PLUGIN_NAME) : {};

    function toBool(v, dflt) {
        if (v === undefined || v === null || v === '') return dflt;
        return String(v).toLowerCase() !== 'false' && String(v) !== '0';
    }
    function toNum(v, dflt) {
        var n = Number(v);
        return isNaN(n) ? dflt : n;
    }

    // ── 中文标点禁则（与 native/common/wrap.h 同一套规则）──
    //   行首禁则：收尾类标点不能出现在一行开头
    var LINE_START_FORBIDDEN = {};
    ('，。、；：？！）】》」』〕〉｝…—”’％℃｡､･｣ー').split('').forEach(function (c) {
        LINE_START_FORBIDDEN[c] = true;
    });
    //   行尾禁则：开类括号引号不能出现在一行结尾
    var LINE_END_FORBIDDEN = {};
    ('（【《「『〔〈｛“‘＄￥＃').split('').forEach(function (c) {
        LINE_END_FORBIDDEN[c] = true;
    });

    var BB = {
        version: 1,
        enabled: toBool(params.Enabled, true),
        // 文本小于这个宽度就不折腾（避免给本来就正常的短文本引入风险）
        minWidthToConsider: toNum(params.MinWidthToConsider, 0),
        // 统计（验收用）
        stats: {
            drawTextExCalls: 0,
            wrapsInserted: 0,
            textsWrapped: 0,
            maxLineWidthSeen: 0,
            overflowsSeen: 0,
        },
        // 最近 N 次绘制的"逐行宽度"报告（验收读它）
        reports: [],
        maxReports: 50,
    };
    window.BB_Layout = BB;

    // ── 纯函数部分（便于单独验证）──
    BB.isLineStartForbidden = function (c) { return !!LINE_START_FORBIDDEN[c]; };
    BB.isLineEndForbidden = function (c) { return !!LINE_END_FORBIDDEN[c]; };

    /**
     * 判断"是否应该把当前字符挪到下一行"。
     *
     * @param win      窗口实例（要用它的 textWidth / contents.width）
     * @param textState 引擎的文本状态
     * @param w        当前字符的像素宽（调用方已量好，避免重复测量）
     * @param c        当前字符
     */
    BB.shouldWrapBefore = function (win, textState, w, c) {
        var limit = win.contents.width;                 // 绝对右边界
        // 行内一个字都没有时不换（换了也没用，单字比框还宽只能溢出）
        if (textState.x <= textState.left) return false;
        // ① 直接放不下
        if (textState.x + w > limit) return true;
        // ② 避头点：下一个字是"不能放行首"的标点，而它放不下本行
        //    → 把当前字也一起挪到下一行，让标点跟它做伴
        var next = textState.text[textState.index + 1];
        if (next !== undefined && LINE_START_FORBIDDEN[next]) {
            var wn = win.textWidth(next);
            if (textState.x + w + wn > limit) return true;
        }
        // ③ 避尾点：当前字是"不能放行尾"的开括号类，且它跟下一个字放不下
        //    → 一起挪到下一行
        if (LINE_END_FORBIDDEN[c]) {
            var n2 = textState.text[textState.index + 1];
            if (n2 !== undefined) {
                var wn2 = win.textWidth(n2);
                if (textState.x + w + wn2 > limit) return true;
            }
        }
        return false;
    };

    // ── 安装 ──
    var _processCharacter = Window_Base.prototype.processCharacter;
    var _processNewLine = Window_Base.prototype.processNewLine;
    var _drawTextEx = Window_Base.prototype.drawTextEx;

    /**
     * 记录"这一行画到多宽"——验收就是靠这个断言"不溢出"的。
     * 位置：processNewLine 里、x 被重置之前。
     */
    Window_Base.prototype.processNewLine = function (textState) {
        var rep = this._bbReport;
        if (rep && BB.enabled) {
            var w = textState.x - textState.left;
            if (w > 0) {
                rep.lineWidths.push(w);
                if (w > rep.maxLineWidth) rep.maxLineWidth = w;
                if (w > BB.stats.maxLineWidthSeen) BB.stats.maxLineWidthSeen = w;
                if (w > this.contents.width + 0.5) BB.stats.overflowsSeen++;
            }
        }
        return _processNewLine.apply(this, arguments);
    };

    Window_Base.prototype.processCharacter = function (textState) {
        if (BB.enabled && !this._bbNoWrap && textState && textState.text) {
            var c = textState.text[textState.index];
            // 只对"普通可见字符"做折行判断：
            //   \n 真换行、\f 翻页、\x1b 控制符序列 一律不碰
            if (c !== undefined && c !== '\n' && c !== '\f' && c !== '\x1b') {
                var w = this.textWidth(c);
                if (BB.shouldWrapBefore(this, textState, w, c)) {
                    // ★ 往文本里插一个真的 '\n'；下面的原函数会看到它并
                    //   走 processNewLine —— 字符不丢、不重
                    textState.text = textState.text.slice(0, textState.index) +
                                     '\n' + textState.text.slice(textState.index);
                    BB.stats.wrapsInserted++;
                }
            }
        }
        return _processCharacter.apply(this, arguments);
    };

    /**
     * 包住 drawTextEx：开一个"逐行宽度报告"，画完收尾并留档。
     *
     * 为什么要报告：排版发生在目标进程内部，外部脚本看不到 HDC 也看不到文本框。
     * 让"被注入的一侧"把事实以数字形式吐出来，验收才能做硬断言
     * （和 N2 排版回填用的是同一个思路）。
     */
    Window_Base.prototype.drawTextEx = function (text, x, y) {
        if (!BB.enabled) return _drawTextEx.apply(this, arguments);

        BB.stats.drawTextExCalls++;
        var rep = {
            contentsWidth: this.contents.width,
            left: x,
            fontSize: this.contents.fontSize,
            fontFace: this.contents.fontFace,
            lineWidths: [],
            maxLineWidth: 0,
            wrapCount: BB.stats.wrapsInserted,
            textLength: text ? text.length : 0,
            used: false,
        };
        var prev = this._bbReport;
        this._bbReport = rep;
        try {
            return _drawTextEx.apply(this, arguments);
        } finally {
            this._bbReport = prev;
            var finalW = rep.lineWidths.length ? rep.lineWidths[rep.lineWidths.length - 1] : 0;
            rep.wrapsInThisCall = BB.stats.wrapsInserted - rep.wrapCount;
            if (rep.wrapsInThisCall > 0) {
                BB.stats.textsWrapped++;
                rep.used = true;
                BB.reports.push(rep);
                if (BB.reports.length > BB.maxReports) BB.reports.shift();
            }
        }
    };

    // ── 插件命令：供"一键还原"验证用 ──
    //   BBLayout on   → 开启折行
    //   BBLayout off  → 关闭折行（还原到引擎原样：一行不折）
    //   BBLayout stat → 打印统计
    if (window.Game_Interpreter) {
        var _origPluginCommand = Game_Interpreter.prototype.pluginCommand;
        Game_Interpreter.prototype.pluginCommand = function (command, args) {
            if (command === 'BBLayout') {
                var sub = (args && args[0] || '').toString().toLowerCase();
                if (sub === 'on') { BB.enabled = true; return; }
                if (sub === 'off') { BB.enabled = false; return; }
                if (sub === 'stat') { console.log('[BB_Layout] ' + JSON.stringify(BB.stats)); return; }
            }
            return _origPluginCommand.apply(this, arguments);
        };
    }

    /**
     * 供外部（探针/验收脚本）调用的开关。
     * 还原语义：off 之后 **一行都不会被折**，与未装插件时完全一致。
     */
    BB.setEnabled = function (on) {
        BB.enabled = !!on;
        return BB.enabled;
    };
    BB.resetStats = function () {
        BB.stats = {
            drawTextExCalls: 0, wrapsInserted: 0, textsWrapped: 0,
            maxLineWidthSeen: 0, overflowsSeen: 0,
        };
        BB.reports = [];
    };

    // 启动日志（写不进 game 日志也没关系，探针会读 window.BB_Layout）
    try {
        console.log('[BB_Layout] 已装载：enabled=' + BB.enabled);
    } catch (e) {}
})();
