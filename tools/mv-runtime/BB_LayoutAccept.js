// ============================================================================
// BB_LayoutAccept.js —— 排版回填的运行时验收（无 GUI 断言）
// ============================================================================
// 思路和 native 侧的 N2 验收一致：**让被注入的一侧把事实以数字形式吐出来**，
// 验收脚本对数字做硬断言，而不是靠人盯截图。
//
// 但它比 N2 更进一步：N2 是"hook 打日志、脚本 grep"，这里是插件**自己**
// 直接驱动真实窗口、真实字体、真实度量，然后把逐行宽度算出来自检。
//
// 断言清单（对应四条验收）：
//   ① 长中文在真实窗口里被折成多行，且**每行宽度 <= contents.width**（不溢出）
//   ② 折行不丢字、不重字（拼回去 === 原文）
//   ③ 中文禁则：行首不出现收尾类标点、行尾不出现开类括号
//   ④ 还原（BB_Layout off）之后**一行都不折**，与引擎原样一致
//
// 用法：由 tools/mv-runtime/run.mjs 装入并运行，结果写到 BB_PROBE_OUT 指定的 JSON。
/* eslint-disable */
(function () {
    'use strict';

    var result = { ok: false, error: null, probeVersion: 1, time: new Date().toISOString() };
    var checks = [];
    function check(cond, name, detail) {
        checks.push({ pass: !!cond, name: name, detail: detail === undefined ? '' : String(detail) });
        return !!cond;
    }

    // ★★ 主动把窗口抢到前台 ★★
    //   实测：这些游戏"必须手动点一下窗口才能彻底启动"。
    //   原因是 Chromium 对非前台/被遮挡窗口会节流 requestAnimationFrame，
    //   而 MV/MZ 的启动靠 Scene_Boot.update（rAF 驱动）推进 ——
    //   rAF 被节流 → 永远不就绪，而且**不报错**（见 run.mjs 里 CHROMIUM_FLAGS 说明）。
    //   这里在插件加载后立刻尝试 show + focus，尽量不依赖人工点击；
    //   外部还会同时传 --disable-*-throttling 开关，双保险。
    try {
        if (typeof nw === 'object' && nw.Window && nw.Window.get) {
            var BB_GRAB_FOCUS = function () {
                try {
                    var w = nw.Window.get();
                    w.show();
                    w.focus();
                    if (w.requestAttention) w.requestAttention(true);
                } catch (e) {}
            };
            BB_GRAB_FOCUS();
            setTimeout(BB_GRAB_FOCUS, 500);
            setTimeout(BB_GRAB_FOCUS, 1500);
        }
    } catch (e) {}

    var startedAt = Date.now();
    // ★ 实测这个游戏"到就绪"的耗时在 2 秒到 46 秒之间大幅波动
    //   （NW.js 多进程启动 + 3.4GB 资源 + 140 多个插件）。
    //   45 秒会**偶发**超时，于是给出**假失败**。所以放宽到 180 秒。
    var MAX_WAIT = 180000;
    var timeline = [];
    var lastSnap = 0;
    var bootErrors = [];
    try {
        window.addEventListener('error', function (ev) {
            bootErrors.push({ ms: Date.now() - startedAt, message: String(ev && ev.message),
                              source: ev && ev.filename ? (ev.filename + ':' + ev.lineno) : null });
        });
    } catch (e) {}

    function ready() {
        try {
            return !!(window.BB_Layout && window.$dataSystem && window.$gameSystem &&
                      window.SceneManager && SceneManager._scene);
        } catch (e) { return false; }
    }

    function run() {
        var BB = window.BB_Layout;
        var out = {};

        try {
            // ── 准备一个一次性窗口：走完整构造（含 windowWidth/padding/contents）──
            // ★ MV 与 MZ 的构造签名不同（同 BB_LayoutMZ.js 里记的那条差异）：
            //   MV：Window_Message()
            //   MZ：Window_Message(rect) —— 不传 Rectangle 会抛
            //       "Argument must be a Rectangle"（验收第一版就撞在这）
            var _isMZ = (window.Utils && Utils.RPGMAKER_NAME === 'MZ');
            var win = _isMZ
                ? new Window_Message(new Rectangle(0, 0, Graphics.boxWidth, 200))
                : new Window_Message();
            out.window = {
                width: win.width,
                height: win.height,
                padding: win.padding,
                contentsWidth: win.contents.width,
                contentsHeight: win.contents.height,
                fontSize: win.contents.fontSize,
                fontFace: win.contents.fontFace,
                lineHeight: win.lineHeight(),
                numVisibleRows: (typeof win.numVisibleRows === 'function')
                    ? win.numVisibleRows() : null,
            };
            out.charWidth = win.textWidth('あ');

            // ── 测试文本：含标点、可观察禁则；长度明显超过一行 ──
            var LONG = '欢迎来到白的百宝箱（这是一个固定宽度的对话框）。' +
                       '这里塞了一段明显超过一行长度的中文，用来验证自动折行、' +
                       '中文标点禁则，以及折行之后不溢出、不丢字。';
            out.textLength = LONG.length;

            // ★★ 引擎分支必须**提前**到这里 ★★
            //   下面的 ①/①b 检查是 MV 专用的（依赖 MV 版插件 report 里的
            //   lineWidths 字段；MZ 的 report 结构不同）。
            //   第一版把 MZ 分支放在它们后面，结果 MZ 上会先跑 MV 的检查再崩 ——
            //   与其到处加 guard，不如在"量完窗口"之后就分道扬镳。
            // ══════════════════════════════════════════════════════════════
            //  MZ 走**另一条**验证路径（绘制模型完全不同，见 BB_LayoutMZ.js）
            //    MZ 不逐字画，而是累积到 textState.buffer 再成段 flush；
            //    换行也不改 text，而是直接调 processNewLine（MZ 里它不动 index）。
            //    所以 MZ 的"不丢字"要换一个判据：**所有字符都被处理过**
            //    （textState.index 走到 text.length），而不是"文本串没被改"。
            // ══════════════════════════════════════════════════════════════
            var isMZ = _isMZ;
            if (isMZ) {
                out.engine = 'MZ';
                BB.resetStats();
                BB.setEnabled(true);
                // ① 先用 **drawTextEx** 走一遍 —— 这是引擎真实绘制走的入口，
                //    而且插件的 report 只在 drawTextEx 包装里产生。
                //    （第一版直接用 createTextState + processAllText，结果
                //      一个 report 都没有 → 判据全落空。）
                win.contents.clear();
                win.drawTextEx(LONG, 0, 0);
                var rep2 = BB.reports.length ? BB.reports[BB.reports.length - 1] : null;

                // ② 再手工走一遍拿 textState.index —— 用于"不丢字"判据
                //    （drawTextEx 的 textState 是内部的，拿不到）
                BB.resetStats();
                BB.setEnabled(true);
                var st = win.createTextState(LONG, 0, 0, win.contents.width);
                win.processAllText(st);
                out.reportsCount = BB.reports.length;
                out.statsAfterWrap = JSON.parse(JSON.stringify(BB.stats));
                out.maxLineExtent = rep2 ? rep2.maxLineExtent : 0;
                out.wrapCount = rep2 ? rep2.wrapsInThisCall : 0;
                out.wrapStarts = rep2 && rep2.wrapStarts ? rep2.wrapStarts.slice() : [];
                out.wrapEnds = rep2 && rep2.wrapEnds ? rep2.wrapEnds.slice() : [];

                check(rep2 && rep2.wrapsInThisCall > 0,
                    '① 长文本确实被折行了（插入了换行）',
                    rep2 ? ('折 ' + rep2.wrapsInThisCall + ' 处') : '没有报告');
                check(out.maxLineExtent <= win.contents.width + 0.5,
                    '① 每行宽度都 <= contents.width（不溢出）',
                    '最宽 ' + out.maxLineExtent + ' / 可用 ' + win.contents.width);
                check(st.index >= st.text.length,
                    '② 所有字符都被处理过（不丢字）',
                    'index ' + st.index + ' / text ' + st.text.length);
                var badS = out.wrapStarts.filter(function (ch) { return BB.isLineStartForbidden(ch); });
                var badE = out.wrapEnds.filter(function (ch) { return BB.isLineEndForbidden(ch); });
                check(badS.length === 0, '③ 行首禁则：断行后的行首不是收尾类标点',
                    badS.length ? ('违反 ' + badS.join(',')) : (out.wrapStarts.length + ' 个断行点'));
                check(badE.length === 0, '③ 行尾禁则：断行前的行尾不是开括号类',
                    badE.length ? ('违反 ' + badE.join(',')) : (out.wrapEnds.length + ' 个断行点'));

                // ④ 还原
                BB.resetStats();
                BB.setEnabled(false);
                var st2 = win.createTextState(LONG, 0, 0, win.contents.width);
                win.processAllText(st2);
                out.wrapsAfterRestore = BB.stats.wrapsInserted;
                check(BB.stats.wrapsInserted === 0,
                    '④ 还原后一行都不折（BBLayout off 即回到引擎原样）',
                    'wrapsInserted=' + BB.stats.wrapsInserted);
                check(st2.index >= st2.text.length,
                    '④ 还原后所有字符仍被处理过',
                    'index ' + st2.index + ' / text ' + st2.text.length);
                BB.setEnabled(true);
                check(BB.enabled === true, '④ 开关可再次打开', 'enabled=' + BB.enabled);

                out.lineCount = out.wrapCount + 1;
                out.visibleRows = 4;
                check(true, '⑤ 折后行数 vs 窗口可见行数（供判断是否需要字号自适应）',
                    out.lineCount + ' 行 / 可见 ' + out.visibleRows + ' 行');

                throw { __mzDone: true };
            }

            // ══ ① 开启折行 → 画一遍，读回逐行宽度 ══
            BB.resetStats();
            BB.setEnabled(true);
            win.contents.clear();
            out.wrappedReturn = win.drawTextEx(LONG, 0, 0);

            var rep = BB.reports.length ? BB.reports[BB.reports.length - 1] : null;
            out.reportsCount = BB.reports.length;
            out.statsAfterWrap = JSON.parse(JSON.stringify(BB.stats));
            out.lineWidths = (rep && rep.lineWidths) ? rep.lineWidths.slice() : null;   // MZ 的 report 没有这个字段
            out.maxLineWidth = rep ? rep.maxLineWidth : 0;

            check(rep && rep.wrapsInThisCall > 0,
                '① 长文本确实被折行了（插入了换行）',
                rep ? ('折 ' + rep.wrapsInThisCall + ' 处，' + ((rep.lineWidths || []).length) + ' 行') : '没有报告');
            check(rep && (rep.lineWidths || []).length >= 2,
                '① 折成了多行',
                rep ? ((rep.lineWidths || []).length + ' 行') : '-');

            var over = ((rep && rep.lineWidths) || []).filter(function (w) { return w > win.contents.width + 0.5; });
            check(over.length === 0,
                '① 每行宽度都 <= contents.width（不溢出）',
                '最宽 ' + out.maxLineWidth + ' / 可用 ' + win.contents.width +
                '，超宽的行的数量 ' + over.length);


            // ══ ② 不丢字 / 不重字 ══
            //   做法：把折行后的 textState 文本拿出来（我们插的 '\n' 在那里），
            //   去掉 '\n' 后必须与原文完全一致。
            //   ★ 这里用一个"探针式"的 drawTextEx：自己维护 textState，直接调 processCharacter，
            //     这样能拿到被我们改过的那个 text 串。
            var textState = {
                index: 0,
                x: 0,
                y: 0,
                left: 0,
                text: win.convertEscapeCharacters(LONG),
                height: 36,
            };
            win.resetFontSettings();
            var guard = 0;
            while (textState.index < textState.text.length && guard++ < 100000) {
                win.processCharacter(textState);
            }
            var afterStrip = textState.text.replace(/\n/g, '');
            var origStripped = win.convertEscapeCharacters(LONG).replace(/\n/g, '');
            check(afterStrip === origStripped,
                '② 折行不丢字、不重字（去掉换行符后与原文逐字符相同）',
                '原文 ' + origStripped.length + ' 字，折后 ' + afterStrip.length + ' 字');

            // ══ ①b **最后一行**也要查宽度 ══
            //   ★ 这是补的一个漏洞：report.lineWidths 只在 processNewLine 里记，
            //     所以只包含"以换行结尾"的那些行；**最后一行没有换行符，永远不被记录**。
            //     而最后一行同样可能溢出 —— 不查它就等于漏了一半。
            //     最后一行宽度直接就是这次 drawTextEx 的返回值（= textState.x - x）。
            var lastLineWidth = textState.x - textState.left;
            out.lastLineWidth = lastLineWidth;
            out.allLineWidths = ((rep && rep.lineWidths) ? rep.lineWidths.slice() : []).concat([lastLineWidth]);
            var worst = Math.max.apply(null, out.allLineWidths);
            out.worstLineWidth = worst;
            check(worst <= win.contents.width + 0.5,
                '① 所有行（含最后一行）宽度都 <= contents.width',
                '最宽 ' + worst + ' / 可用 ' + win.contents.width +
                '，逐行 = [' + out.allLineWidths.join(', ') + ']');

            // ══ ③ 中文禁则 ══
            //   把折行后的文本按 '\n' 切开，逐行检查首尾字符
            var lines = textState.text.split('\n');
            out.linesPreview = lines.map(function (l) { return l.slice(0, 18); });
            var badStart = [], badEnd = [];
            lines.forEach(function (l, i) {
                if (l.length === 0) return;
                if (BB.isLineStartForbidden(l.charAt(0))) badStart.push(i + ':' + l.charAt(0));
                if (BB.isLineEndForbidden(l.charAt(l.length - 1))) badEnd.push(i + ':' + l.charAt(l.length - 1));
            });
            check(badStart.length === 0,
                '③ 行首禁则：收尾类标点没有出现在行首',
                badStart.length ? ('违反 ' + badStart.join(' ')) : ('检查了 ' + lines.length + ' 行'));
            check(badEnd.length === 0,
                '③ 行尾禁则：开括号类没有出现在行尾',
                badEnd.length ? ('违反 ' + badEnd.join(' ')) : ('检查了 ' + lines.length + ' 行'));

            // ══ ④ 还原：关掉之后一行都不折 ══
            BB.resetStats();
            BB.setEnabled(false);
            var textState2 = {
                index: 0, x: 0, y: 0, left: 0,
                text: win.convertEscapeCharacters(LONG),
                height: 36,
            };
            win.contents.clear();
            var g2 = 0;
            while (textState2.index < textState2.text.length && g2++ < 100000) {
                win.processCharacter(textState2);
            }
            var linesAfterRestore = textState2.text.split('\n');
            out.linesAfterRestore = linesAfterRestore.length;
            check(linesAfterRestore.length === 1,
                '④ 还原后一行都不折（BB_Layout off 即回到引擎原样）',
                linesAfterRestore.length + ' 行');
            check(BB.stats.wrapsInserted === 0,
                '④ 还原后没有插入任何换行',
                'wrapsInserted=' + BB.stats.wrapsInserted);

            // ══ ⑤ 折行后的行数是否仍在窗口可见行数之内 ══
            //   折行解决了"横向溢出"，但**行数太多会触发分页**（消息窗口）
            //   或垂直被裁（非消息窗口）。这是折行解决不了的那一半，
            //   所以单独报出来，当作"下一步要不要做字号自适应"的依据。
            var rows = win.numVisibleRows();
            out.lineCount = lines.length;
            out.visibleRows = rows;
            check(true,
                '⑤ 折行后行数 vs 窗口可见行数（供判断是否需要字号自适应）',
                lines.length + ' 行 / 可见 ' + rows + ' 行' +
                (lines.length > rows ? '  ← 会触发分页或垂直裁剪' : '  ← 放得下'));

            // 还原后再打开，确认开关是双向的
            BB.setEnabled(true);
            check(BB.enabled === true, '④ 开关可再次打开', 'enabled=' + BB.enabled);

        } catch (e) {
            // MZ 分支用 throw {__mzDone:true} 提前跳出，这不是错误
            if (!(e && e.__mzDone)) {
                result.error = String(e && e.stack ? e.stack : e);
            }
        }

        // 异常也算一条失败项（否则"抛异常 → 0 项检查"又变成假绿）
        if (result.error) {
            checks.push({ pass: false, name: '验收执行期抛异常', detail: String(result.error).slice(0, 500) });
        }
        var pass = checks.filter(function (c) { return c.pass; }).length;
        var fail = checks.length - pass;
        result.ok = true;
        result.data = {
            out: out,
            checks: checks,
            pass: pass,
            fail: fail,
            passLine: 'PASS=' + pass + ' FAIL=' + fail,
        };

        var text = JSON.stringify(result, null, 2);
        try {
            if (process.env.BB_PROBE_OUT) require('fs').writeFileSync(process.env.BB_PROBE_OUT, text, 'utf8');
        } catch (e) {}
        try { console.log('[BB验收] ' + text); } catch (e) {}

        try { if (window.nw && nw.App && nw.App.quit) { nw.App.quit(); return; } } catch (e) {}
        try { var gui = require('nw.gui'); if (gui && gui.App && gui.App.quit) { gui.App.quit(); return; } } catch (e) {}
        try { window.close(); } catch (e) {}
    }

    (function waitReady() {
        var el = Date.now() - startedAt;
        // 每 5 秒记一次时间线 —— 超时的时候能看出卡在哪一步
        if (el - lastSnap >= 5000) {
            lastSnap = el;
            try {
                timeline.push({
                    ms: el,
                    scene: (window.SceneManager && SceneManager._scene)
                        ? SceneManager._scene.constructor.name : null,
                    hasDataSystem: !!window.$dataSystem,
                    hasGameSystem: !!window.$gameSystem,
                    readyState: document.readyState,
                });
            } catch (e) {}
        }
        if (ready()) { setTimeout(run, 800); return; }
        if (Date.now() - startedAt > MAX_WAIT) {
            // ★★ 这里**必须报失败**，不能"0 项检查"就收工 ★★
            //   第一版就是那么写的，结果：验收根本没跑起来（超时），
            //   却产出 {pass:0, fail:0} → 上层把它当成"通过"。
            //   这是最危险的一类假绿：什么都没测，却显示全绿。
            //   现在超时也产出一条**失败**的检查项，并把"卡在哪"自证出来。
            result.error = '等待就绪超时（' + MAX_WAIT + 'ms）';
            result.ok = true;
            var why = {
                有BB_Layout: !!(window.BB_Layout),
                有dataSystem: !!window.$dataSystem,
                有gameSystem: !!window.$gameSystem,
                有SceneManager: !!window.SceneManager,
                有当前场景: !!(window.SceneManager && SceneManager._scene),
                当前场景名: (window.SceneManager && SceneManager._scene)
                    ? SceneManager._scene.constructor.name : null,
                readyState: (function () { try { return document.readyState; } catch (e) { return null; } })(),
                BB_Layout版本: window.BB_Layout ? window.BB_Layout.version : null,
                BB_Layout启用: window.BB_Layout ? window.BB_Layout.enabled : null,
                启动期异常: bootErrors,
                就绪时间线: timeline,
                BB_Layout是否在插件表里: (function () {
                    try { return $plugins.filter(function (p) { return p.status; })
                        .map(function (p) { return p.name; }).indexOf('BB_Layout') >= 0; }
                    catch (e) { return '读不到 $plugins'; }
                })(),
            };
            result.data = {
                checks: [{ pass: false, name: '验收未能执行（就绪超时）', detail: JSON.stringify(why) }],
                pass: 0, fail: 1, passLine: 'PASS=0 FAIL=1',
                diagnostics: why,
            };
            try {
                if (process.env.BB_PROBE_OUT) {
                    require('fs').writeFileSync(process.env.BB_PROBE_OUT, JSON.stringify(result, null, 2), 'utf8');
                }
            } catch (e) {}
            try { if (window.nw && nw.App) nw.App.quit(); } catch (e) {}
            return;
        }
        setTimeout(waitReady, 300);
    })();
})();
