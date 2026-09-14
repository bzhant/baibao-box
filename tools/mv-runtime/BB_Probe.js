// ============================================================================
// MV 运行时探针（BB_Probe.js）—— 只读，不改任何游戏行为
// ============================================================================
// 用途：把"排版相关的真实参数"从**推断**变成**实测**。
//
// 为什么需要它：
//   静态分析给出的链条是「消息窗 640 → contents 604px → 字号 28px → 约 21.6 全角字/行」，
//   但按这个容量统计，该游戏**自己的对白有 35% 超过单行** —— 这不像一个正常发售的游戏。
//   说明链条里至少有一环是错的，而错在哪只能实测。
//
// 设计要点：
//   · **只读**：只 new 一个一次性的 Window_Message 来量，不碰正在用的窗口
//   · **落盘**：NW.js 的 console 不好抓，所以用 Node 的 fs 直接写 JSON
//     （MV 本身就用 Node 的 fs 存档，所以渲染进程一定有 require）
//   · **自己退出**：量完主动 quit，不需要外部 kill（也避免残留进程）
//   · 输出路径由环境变量 BB_PROBE_OUT 指定，默认写到游戏目录
//
// 安装/卸载由 tools/mv-probe/run.mjs 负责（备份 → 安装 → 跑 → 收集 → 还原）。
/* eslint-disable */
(function () {
    'use strict';

    var OUT = null;
    try {
        var path = require('path');
        var fs = require('fs');
        OUT = process.env.BB_PROBE_OUT ||
              path.join(process.cwd(), 'bb_probe_result.json');
    } catch (e) {
        // 没有 Node（纯浏览器模式的 NW.js）就没法落盘，只能退回 console
        OUT = null;
    }

    function round(n) { return typeof n === 'number' ? Math.round(n * 100) / 100 : n; }

    /** 挑一个长一点的真实日文样本，用来验证"到底会不会溢出" */
    var SAMPLE_JA =
        'シルフィーナ: 「あっ♡ あんぅぅ♡ だ、だめぇ♡ い、いかされちゃう♡ おちんぽでいかされちゃう♡ あくぅぅ♡」';
    /** 同样长度的中文，用来比较换字体后的宽度 */
    var SAMPLE_ZH =
        '希尔菲娜：「啊♡ 嗯呜♡ 不、不行♡ 要、要被弄到高潮了♡ 被肉棒弄到高潮了♡ 啊呜♡」';

    var result = {
        ok: false,
        error: null,
        time: new Date().toISOString(),
        probeVersion: 1,
    };

    function collect() {
        var r = {};

        // ── 1) 图形子系统 ──
        r.graphics = {
            width: Graphics.width,
            height: Graphics.height,
            boxWidth: Graphics.boxWidth,
            boxHeight: Graphics.boxHeight,
            rendererType: Graphics._rendererType || '(未知)',
            isNwjs: Utils.isNwjs(),
            rpgmakerName: (window.Utils && Utils.RPGMAKER_NAME) || '(未知)',
            rpgmakerVersion: (window.Utils && Utils.RPGMAKER_VERSION) || '(未知)',
            devicePixelRatio: window.devicePixelRatio,
        };

        // ── 2) 消息窗口的"真实"参数 ──
        //   ★ 关键：不要在正在用的窗口上量（可能被场景状态影响），
        //     直接 new 一个一次性的 Window_Message —— 它的构造过程会走完整套
        //     windowWidth()/updatePadding()/updateContents()，量出来就是真值。
        var wm = null;
        try {
            if (!$gameSystem) throw new Error('$gameSystem 尚未建立（游戏还在启动）');
            // ★ MV 与 MZ 的构造签名不同：
            //   MV：Window_Message() —— 内部自己走 windowWidth() 算尺寸
            //   MZ：Window_Message(rect) —— rect 是 Rectangle；不传会抛
            //       "Argument must be a Rectangle"（第一版探针就撞在这）
            if (Utils.RPGMAKER_NAME === 'MZ') {
                wm = new Window_Message(new Rectangle(0, 0, Graphics.boxWidth, 200));
            } else {
                wm = new Window_Message();
            }
            r.messageWindow = {
                windowWidthFn: (typeof wm.windowWidth === 'function') ? wm.windowWidth() : null,
                width: wm.width,
                height: wm.height,
                padding: wm.padding,
                contentsWidth: wm.contents ? wm.contents.width : null,
                contentsHeight: wm.contents ? wm.contents.height : null,
                fontSize: wm.contents ? wm.contents.fontSize : null,
                fontFace: wm.contents ? wm.contents.fontFace : null,
                lineHeight: (typeof wm.lineHeight === 'function') ? wm.lineHeight() : null,
                numVisibleRows: (typeof wm.numVisibleRows === 'function') ? wm.numVisibleRows() : null,
                // 引擎里"可折行宽度"的定义（YEP 用的就是它）
                wordwrapWidth: (typeof wm.wordwrapWidth === 'function') ? wm.wordwrapWidth() : null,
                // 行首 x：有头像时会右移，这里记一下
                newLineX: (typeof wm.newLineX === 'function') ? wm.newLineX() : null,
                _wordWrap: wm._wordWrap,
            };
        } catch (e) {
            r.messageWindow = { error: String(e) };
        }

        // ── 3) 引擎与插件给出的宽度/字号来源 ──
        // ★ 这里每一项都要单独 guard。
        //   MV 与 MZ 的 API 名字不同：MV 有 Window_Base.standardFontSize/standardPadding，
        //   MZ 全都搬到了 $gameSystem（mainFontFace/mainFontSize）。
        //   第一版整块共用一个 try，结果 MZ 上第一个未定义就抛了，
        //   整块 sources 只剩一句 "Cannot read property 'call' of undefined"，
        //   把后面本来能读到的信息也一起丢了。
        var src = {};
        var tryGet = function (key, fn) {
            try { src[key] = fn(); } catch (e) { src[key] = '(不可用: ' + e.message + ')'; }
        };
        tryGet('gameSystemMessageWidth', function () { return $gameSystem.messageWidth(); });
        tryGet('gameSystemWordWrap', function () { return $gameSystem.wordWrap(); });
        tryGet('baseStandardFontSize', function () {
            return Window_Base.prototype.standardFontSize.call(wm); });
        tryGet('baseStandardPadding', function () {
            return Window_Base.prototype.standardPadding.call(wm); });
        tryGet('baseStandardFontFace', function () {
            return Window_Base.prototype.standardFontFace.call(wm); });
        tryGet('gameSystemMainFontFace', function () { return $gameSystem.mainFontFace(); });
        tryGet('gameSystemMainFontSize', function () { return $gameSystem.mainFontSize(); });
        tryGet('paramMSGFontSize', function () { return Yanfly.Param.MSGFontSize; });
        tryGet('paramMSGDefaultWidth', function () { return Yanfly.Param.MSGDefaultWidth; });
        tryGet('paramMSGWordWrap', function () { return Yanfly.Param.MSGWordWrap; });
        tryGet('locale', function () { return $dataSystem.locale; });
        tryGet('isChinese', function () { return $gameSystem.isChinese(); });
        tryGet('dataSystemAdvanced', function () { return $dataSystem.advanced || null; });
        r.sources = src;

        // ── 4) 实测字宽（这是整份报告要的核心数字）──
        if (wm && wm.contents) {
            var meas = {};
            var samples = [1, 5, 10, 16, 20, 21, 22, 26, 32, 40];
            for (var i = 0; i < samples.length; i++) {
                var n = samples[i];
                meas['あx' + n] = wm.textWidth(new Array(n + 1).join('あ'));
            }
            meas['A x10'] = wm.textWidth('AAAAAAAAAA');
            meas['SAMPLE_JA'] = wm.textWidth(SAMPLE_JA);
            meas['SAMPLE_ZH'] = wm.textWidth(SAMPLE_ZH);
            meas['SAMPLE_JA_len'] = SAMPLE_JA.length;
            meas['SAMPLE_ZH_len'] = SAMPLE_ZH.length;
            r.measured = meas;

            // 每字宽 + 单行能吃多少字
            var w1 = meas['あx1'];
            r.derived = {
                pxPerFullWidthChar: round(w1),
                fullWidthCharsPerLine: w1 > 0 ? round(wm.contents.width / w1) : null,
                sampleJaFitsInOneLine: meas['SAMPLE_JA'] <= wm.contents.width,
                sampleZhFitsInOneLine: meas['SAMPLE_ZH'] <= wm.contents.width,
                sampleJaOverflowPx: round(meas['SAMPLE_JA'] - wm.contents.width),
                sampleZhOverflowPx: round(meas['SAMPLE_ZH'] - wm.contents.width),
            };
        }

        // ── 5) 当前场景里有没有活的 Window_Message（确认上面的 new 与真实一致）──
        try {
            var scene = SceneManager._scene;
            r.scene = {
                name: scene ? scene.constructor.name : null,
                hasWindowLayer: !!(scene && scene._windowLayer),
                liveMessageWindow: null,
            };
            if (scene && scene._windowLayer) {
                var kids = scene._windowLayer.children;
                for (var k = 0; k < kids.length; k++) {
                    if (kids[k] instanceof Window_Message) {
                        var lw = kids[k];
                        r.scene.liveMessageWindow = {
                            width: lw.width,
                            padding: lw.padding,
                            contentsWidth: lw.contents ? lw.contents.width : null,
                            fontSize: lw.contents ? lw.contents.fontSize : null,
                        };
                        break;
                    }
                }
            }
        } catch (e) {
            r.scene = { error: String(e) };
        }

        // ── 6) 已加载的插件清单（确认探针装上了、以及有没有别的排版插件）──
        try {
            r.plugins = $plugins.filter(function (p) { return p.status; }).map(function (p) { return p.name; });
        } catch (e) {
            r.plugins = ['(读不到)'];
        }

        return r;
    }

    function finish() {
        try {
            result.data = collect();
            result.data.timeline = timeline;
            result.data.bootErrors = bootErrors;
            result.ok = true;
        } catch (e) {
            result.error = String(e && e.stack ? e.stack : e);
        }

        var text = JSON.stringify(result, null, 2);
        try {
            if (OUT) require('fs').writeFileSync(OUT, text, 'utf8');
        } catch (e) {
            /* 落盘失败就只能靠 console */
        }
        try { console.log('[BB探针] ' + text); } catch (e) {}

        // 量完就自己退出，避免留下挂着窗口的进程
        try {
            if (window.nw && nw.App && nw.App.quit) { nw.App.quit(); return; }
        } catch (e) {}
        try {
            var gui = require('nw.gui');
            if (gui && gui.App && gui.App.quit) { gui.App.quit(); return; }
        } catch (e) {}
        try { window.close(); } catch (e) {}
    }

    // ── 启动期时间线 ──
    //
    // ★ 为什么要有这个：第一次跑探针时，等了 45 秒 `$gameSystem` 仍是 null、
    //   `SceneManager._scene` 也是 null —— 说明游戏**卡在启动阶段**。
    //   但"卡住了"这个结论本身没告诉我卡在哪。所以每隔一段时间抓一次关键状态，
    //   变成一个时间线；同时挂上 window.onerror 捕获启动期异常。
    //   这样即使一直没就绪，也能从时间线看出是哪一步没过。
    var timeline = [];
    function snapshot(tag) {
        var s = { tag: tag, ms: Date.now() - startedAt };
        try { s.readyState = document.readyState; } catch (e) {}
        try { s.scene = SceneManager._scene ? SceneManager._scene.constructor.name : null; } catch (e) { s.sceneErr = String(e); }
        try { s.sceneChanging = SceneManager.isSceneChanging ? SceneManager.isSceneChanging() : null; } catch (e) {}
        try { s.hasDataSystem = (typeof $dataSystem !== 'undefined') && !!$dataSystem; } catch (e) {}
        try { s.hasGameSystem = (typeof $gameSystem !== 'undefined') && !!$gameSystem; } catch (e) {}
        try { s.dbLoaded = DataManager.isDatabaseLoaded(); } catch (e) { s.dbLoadedErr = String(e); }
        try { s.graphics = Graphics.width + 'x' + Graphics.height; } catch (e) {}
        try { s.nwWin = (window.nw && nw.Window && nw.Window.get) ? 'yes' : 'no'; } catch (e) {}
        timeline.push(s);
        return s;
    }

    var bootErrors = [];
    window.addEventListener('error', function (ev) {
        bootErrors.push({
            ms: Date.now() - startedAt,
            message: String(ev && ev.message),
            source: ev && ev.filename ? (ev.filename + ':' + ev.lineno) : null,
        });
    });

    // ── 等游戏"真正就绪"再量 ──
    //
    // ★ 第一版用了固定 5 秒，结果量到的是**启动过程中**的状态：
    //   `$dataSystem` 与 `$gameSystem` 还是 null、`SceneManager._scene` 也是 null，
    //   于是 `new Window_Message()` 直接抛
    //   "Cannot read property 'messageWidth' of null"。
    //   固定等待本身就不可靠（机器快慢、标题画面加载时间都不一样）。
    //   改成**轮询就绪条件**：数据库加载完 + $gameSystem 存在 + 场景已建立。
    //   并且一旦就绪就立刻量、立刻退出，不浪费时间。
    var MAX_WAIT_MS = 45000;
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
    var lastSnap = 0;

    function ready() {
        try {
            if (typeof $dataSystem === 'undefined' || !$dataSystem) return false;
            if (typeof $gameSystem === 'undefined' || !$gameSystem) return false;
            if (!SceneManager._scene) return false;
            return true;
        } catch (e) {
            return false;
        }
    }

    (function waitReady() {
        var el = Date.now() - startedAt;

        // 每 3 秒抓一次时间线，方便定位"卡在哪一步"
        if (el - lastSnap >= 3000) {
            lastSnap = el;
            var s = snapshot('poll');
            try { console.log('[BB探针] 时间线 ' + JSON.stringify(s)); } catch (e) {}
        }

        if (ready()) {
            snapshot('ready');
            // 就绪了也稍等一下，让首个场景把窗口都建出来（这样能顺带量到"活窗口"）
            setTimeout(finish, 800);
            return;
        }
        if (el > MAX_WAIT_MS) {
            snapshot('timeout');
            result.error = '等待就绪超时（' + MAX_WAIT_MS + 'ms）';
            finish();
            return;
        }
        setTimeout(waitReady, 300);
    })();
})();
