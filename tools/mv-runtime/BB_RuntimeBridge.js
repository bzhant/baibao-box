// ============================================================================
// BB_RuntimeBridge.js —— 运行时取词桥（MV / MZ）
// ============================================================================
// 它补的是"原生侧 toyHook 在 MV/MZ 上够不到"的那一环。
//
// 为什么 MV/MZ 不能用原生编码层 hook：
//   MV/MZ 跑在 NW.js 上，文本是 **JS 字符串**，从数据到画面全程不经过
//   MultiByteToWideChar 这类原生文本 API —— 编码层 hook 在这类引擎上**看不见任何东西**。
//   所以引擎侧的拦截点必须在 JS 层：挂在真实绘制入口上。
//
// 它做的事和原生侧 toyHook **完全同构**（同一套总线协议、同样的三条约束）：
//   热路径遇到没见过的原文 → 登记 → 定时批量问宿主 → 译文进缓存 → 下次绘制换成中文
//   ① 绝不阻塞绘制（未命中就放行原文）
//   ② 同一句只问一次（负缓存）
//   ③ 宿主不在就自己停下（连续失败即停用，游戏照常玩）
//
// 两种模式（由环境变量决定）：
//   · **自检模式**（给了 BB_PROBE_OUT）：往真实窗口里画一句"只有宿主才翻得出"的日文，
//     断言热路径登记了它、译文到了、且**第二次绘制用的就是宿主的译文**，写结果 JSON 后退出游戏。
//     由 tools/mv-runtime/run.mjs 装入运行（自动验收用）。
//   · **常驻模式**（没给 BB_PROBE_OUT）：只挂绘制入口 + 连总线 + 持续取词，
//     **不退出游戏** —— 这是产品里"运行时模式"用的形态。日志写到 BB_BRIDGE_LOG。
//
// 环境变量：BB_BUS_PORT（宿主总线端口，必给）、BB_PROBE_OUT、BB_BRIDGE_LOG
/* eslint-disable */
(function () {
    'use strict';

    if (typeof window === 'undefined' || typeof Window_Base === 'undefined') return;

    var PORT = Number(process.env.BB_BUS_PORT || 0);
    var OUT = process.env.BB_PROBE_OUT;
    var LOGPATH = process.env.BB_BRIDGE_LOG;
    var SELFTEST = !!OUT;                       // 有结果文件路径 = 自检模式
    var MARK = '【中】';                        // 自检用确定性"翻译"的前缀（见 runtime-real-game.test.ts）
    var TEST_JP = 'ランタイム橋の試験文です。宿主から訳文を受け取ります。';

    var result = { ok: false, error: null, bridgeVersion: 2, mode: SELFTEST ? 'selftest' : 'serve', time: new Date().toISOString() };
    var checks = [];
    function check(cond, name, detail) {
        checks.push({ pass: !!cond, name: name, detail: detail === undefined ? '' : String(detail) });
        return !!cond;
    }

    var t0 = Date.now();
    var timeline = [];
    var fsmod = null;
    try { fsmod = require('fs'); } catch (e) {}
    function note(s) {
        timeline.push(((Date.now() - t0) / 1000).toFixed(1) + 's  ' + s);
        if (timeline.length > 400) timeline.splice(0, 200);
        if (LOGPATH && fsmod) { try { fsmod.appendFileSync(LOGPATH, new Date().toISOString() + '  ' + s + '\n'); } catch (e) {} }
        try { console.log('[BB桥] ' + s); } catch (e) {}
    }

    // ── 运行时取词状态（与原生侧同名同义，便于对着看）──────────────────
    var cache = {};      // 原文 → 译文（宿主给的；空串=宿主答"没有"，负缓存）
    var asked = {};      // 已问过
    var queue = [];      // 待问（防止把宿主刷爆）
    var MAXQ = 512;
    var stats = { seen: 0, queued: 0, got: 0, applied: 0, rejected: 0, foreign: 0, samples: [] };
    var drawn = null;    // 最近一次绘制实际用的文本（自检要看这个）
    var winInfo = null;  // 自检时记下的真实窗口参数

    /**
     * 值得送去翻译的才算文本。
     * JS 层同样会遇到数字、符号、内部键 —— 判据同样取最朴素的一条：
     * **含非 ASCII 字符**且长度合理。
     */
    function looksLikeText(t) {
        return typeof t === 'string' && t.length >= 2 && t.length <= 400 && /[^\x00-\x7F]/.test(t);
    }

    /** 热路径：查缓存；未命中就登记（不阻塞、不等待） */
    function throughBridge(text) {
        var t = String(text);
        if (!looksLikeText(t)) return t;
        stats.seen++;
        if (t !== TEST_JP) stats.foreign++;          // 游戏自己画的文本（证明钩子挂在真实绘制路径上）
        var hit = cache[t];
        if (hit) {
            stats.applied++;
            if (stats.samples.length < 10) stats.samples.push({ src: t, dst: hit });
            return hit;
        }
        if (!asked[t] && queue.length < MAXQ) { asked[t] = 1; queue.push(t); stats.queued++; }
        return t;                                     // 没有译文 → 原样放行（绝不等待）
    }
    window.BB_Bridge_lookup = throughBridge;          // 便于在控制台/其它插件里手动调用

    // ── 挂在真实绘制入口上 ────────────────────────────────────────────
    //   Window_Base.prototype.drawText 是所有"一行简单文本"的必经之处
    //   （菜单项、数值标签、道具名……），也是自检喂测试文本的入口。
    var _drawText = Window_Base.prototype.drawText;
    Window_Base.prototype.drawText = function (text, x, y, maxWidth, align) {
        var t = (text === null || text === undefined) ? '' : String(text);
        var out = throughBridge(t);
        drawn = { src: t, used: out, substituted: out !== t };
        return _drawText.call(this, out, x, y, maxWidth, align);
    };

    // ── 宿主总线（与原生侧同一套：plain JSON 线格式）────────────────────
    var ws = null;
    var connected = false;
    var identified = false;
    var nextId = 100;
    var waiting = {};                                  // id → 回调
    var failStreak = 0;
    var disabled = false;

    function send(obj) {
        if (!ws || ws.readyState !== 1) return false;
        try { ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
    }

    function request(cmd, args, cb) {
        var id = ++nextId;
        if (cb) {
            waiting[id] = cb;
            // 超时保护：宿主不回也不能把这条通道永久占住
            setTimeout(function () { if (waiting[id]) { delete waiting[id]; cb(null); } }, 4000);
        }
        if (!send({ id: id, type: 0, target: 0, cmd: cmd, args: args })) {
            if (cb) delete waiting[id];
            return false;
        }
        return true;
    }

    function identity() {
        var engine = 'mvmz';
        try { if (window.Utils && Utils.RPGMAKER_NAME) engine = Utils.RPGMAKER_NAME; } catch (e) {}
        var exePath = '';
        try { exePath = String(process.execPath || ''); } catch (e) {}
        return { exePath: exePath, pid: process.pid, module: 'BB_RuntimeBridge', engine: engine, arch: 64 };
    }

    function onMessage(ev) {
        var msg;
        try { msg = JSON.parse(ev.data); } catch (e) { return; }
        if (msg && msg.cmd === 'whoareyou') {
            // 握手：用**同一个 id** 把身份发回去（与原生侧一致）
            send({ id: msg.id, type: 0, target: 0, cmd: 'whoareyou', args: identity() });
            if (!identified) {
                identified = true;
                note('已应答 whoareyou（' + (SELFTEST ? '自检模式' : '常驻模式') + '）');
                window.BB_Bridge_ready = true;
            }
            return;
        }
        if (msg && msg.cmd) {
            // 宿主 → 桥 的请求：**必须回**；未知命令明确报错（与总线的同一条规矩：
            // 静默吞掉只会让宿主那边看到"发出去没反应"，无从排查）
            var reply = { id: msg.id, type: 1, error: false };
            if (msg.cmd === 'runtimeStat') {
                reply.ret = {
                    run: disabled ? 0 : 1,
                    req: stats.queued, got: stats.got,
                    none: stats.rejected, apply: stats.applied,
                };
            } else {
                reply.error = true;
                reply.ret = '未知命令: ' + msg.cmd;
            }
            send(reply);
            return;
        }
        if (msg && msg.id !== undefined && waiting[msg.id]) {
            var cb = waiting[msg.id];
            delete waiting[msg.id];
            cb(msg);
        }
    }

    /**
     * 译文到了就**主动刷新文本窗口**。
     *
     * 为什么必须有：取词是"先登记、后拿译文"，而回填只在**下一次绘制**时发生。
     * 可游戏不一定马上重绘 —— 标题界面、静态菜单可能长时间一帧不画，
     * 于是译文到了却迟迟不显示（实测：4 条译文到位，apply 一直是 0）。
     * 主动 refresh 一次就把"等待下一次自然重绘"变成"立刻生效"，
     * 而且 refresh 是直接绘制，不受 rAF 被节流的影响。
     */
    function refreshTextWindows() {
        try {
            var sc = (typeof SceneManager !== 'undefined') ? SceneManager._scene : null;
            if (!sc) return;
            var stack = [sc];
            var guard = 0;
            while (stack.length > 0 && guard++ < 500) {
                var o = stack.pop();
                if (!o) continue;
                if (typeof o.refresh === 'function' && o.contents) {
                    try { o.refresh(); } catch (e) { /* 单个窗口失败不影响其它 */ }
                }
                var ch = o.children;
                if (ch && ch.length) for (var i = 0; i < ch.length; i++) stack.push(ch[i]);
            }
        } catch (e) { /* 刷新只是"尽快生效"，失败也不影响正确性 */ }
    }

    // ── 取词：定时批量问宿主 ──────────────────────────────────────────
    function pump() {
        if (disabled || !identified || !connected || queue.length === 0) return;
        var batch = queue.splice(0, 16);
        var items = batch.map(function (s) { return { src: s }; });
        var requeue = function () {
            for (var i = 0; i < batch.length; i++) { delete asked[batch[i]]; if (queue.length < MAXQ) queue.push(batch[i]); }
        };
        var okSent = request('translate', { from: 'ja', to: 'zh-CN', items: items }, function (reply) {
            if (!reply || reply.error || !reply.ret || !reply.ret.items) {
                failStreak++;
                if (failStreak >= 3) { disabled = true; note('宿主连续无应答 → 停用运行时取词（游戏照常）'); }
                requeue();
                return;
            }
            failStreak = 0;
            var its = reply.ret.items || [];
            var before = stats.got;
            var miss = 0;
            for (var j = 0; j < its.length; j++) {
                var it = its[j];
                if (it && it.src && it.dst) { cache[it.src] = it.dst; stats.got++; }
                else if (it && it.src) { cache[it.src] = ''; stats.rejected++; }   // 负缓存，不再问
            }
            note('取词应答：' + (its.length - miss) + '/' + its.length + ' 条有译文（累计 got=' + stats.got + ' apply=' + stats.applied + '）');
            // ★ 有新译文 → 立刻刷新，让它当场生效（否则要等下一次自然重绘）
            if (stats.got > before) refreshTextWindows();
        });
        if (!okSent) requeue();
    }

    function connectBus() {
        if (!PORT) { note('没有 BB_BUS_PORT —— 跳过总线连接（只在本地跑，不做替换）'); return; }
        try { ws = new WebSocket('ws://127.0.0.1:' + PORT + '/plain'); } catch (e) { note('WebSocket 创建失败：' + e.message); return; }
        ws.onopen = function () { connected = true; note('已连接宿主总线 :' + PORT); };
        ws.onmessage = onMessage;
        ws.onerror = function () { note('总线连接出错（宿主没起？）'); };
        ws.onclose = function () { connected = false; identified = false; note('总线已断开'); };
    }

    // ── 自检模式 ─────────────────────────────────────────────────────
    var startedAt = Date.now();

    function finish() {
        var pass = 0, fail = 0;
        for (var i = 0; i < checks.length; i++) { if (checks[i].pass) pass++; else fail++; }
        result.ok = true;
        result.data = {
            checks: checks, pass: pass, fail: fail,
            passLine: pass + ' 通过 / ' + fail + ' 失败',
            stats: stats, timeline: timeline, drawn: drawn, window: winInfo,
            elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
        };
        try { if (OUT && fsmod) fsmod.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8'); } catch (e) {}
        try { console.log('[BB桥] ' + result.data.passLine); } catch (e) {}
        try { var gui = require('nw.gui'); if (gui && gui.App && gui.App.quit) { gui.App.quit(); return; } } catch (e) {}
        try { window.close(); } catch (e) {}
    }

    // 等游戏就绪 —— 判据与 BB_LayoutAccept 一致（**它已经在真机上验证过**）：
    //   数据库（$dataSystem）与 GameSystem 均已加载、且有当前场景。
    //   只判 "SceneManager 有场景" 太早：那时字体还没设好，度量不可靠。
    var readyWaited = 0;
    function waitReady() {
        readyWaited += 300;
        var ready = false;
        try {
            ready = !!window.$dataSystem && !!window.$gameSystem
                && typeof SceneManager !== 'undefined' && !!SceneManager._scene;
        } catch (e) {}
        if (ready) {
            note('游戏已就绪（数据库与 GameSystem 均已加载）');
            setTimeout(selfTest, 800);   // 留 800ms 沉降，与既有验收一致
            return;
        }
        if (readyWaited > 180000) {
            // ★ 超时**必须产出一条失败项** —— 否则"0 项检查"会被上层当成"通过"（最容易假绿的地方）
            check(false, '游戏在 180 秒内就绪', '超时，未执行任何运行时检查');
            finish();
            return;
        }
        setTimeout(waitReady, 300);
    }

    function selfTest() {
        var win = null;
        try {
            var _isMZ = (window.Utils && Utils.RPGMAKER_NAME === 'MZ');
            win = _isMZ ? new Window_Message(new Rectangle(0, 0, Graphics.boxWidth, 200)) : new Window_Message();
            winInfo = {
                contentsWidth: win.contents.width,
                fontFace: win.contents.fontFace,
                fontSize: win.contents.fontSize,
            };
        } catch (e) {
            check(false, '创建真实窗口', '异常：' + e.message);
            finish();
            return;
        }
        check(identified, '桥已与宿主握手（whoareyou）', identified ? 'ok' : '宿主没连上');
        check(!!win.contents, '拿到真实窗口的位图（真实字体/度量）',
            'contents ' + win.contents.width + 'x' + win.contents.height);

        // ① 第一次绘制：热路径应当"登记待译"并原样放行
        var queuedBefore = stats.queued;
        win.contents.clear();
        win.drawText(TEST_JP, 0, 0, win.contents.width);
        check(stats.queued > queuedBefore, '① 热路径登记了词表外的原文（送宿主翻译）',
            'queued ' + queuedBefore + ' → ' + stats.queued);
        check(drawn && drawn.src === TEST_JP && !drawn.substituted,
            '① 未命中时原样放行（不阻塞绘制）',
            drawn ? ('用的是「' + drawn.used.slice(0, 12) + '…」') : 'n/a');

        // ② 等宿主的译文回来（最多 15 秒）
        var waited = 0;
        (function poll() {
            waited += 200;
            if (cache[TEST_JP]) { step3(win); return; }
            if (waited > 15000) {
                check(false, '② 宿主的译文在 15 秒内到达', '超时（stats.got=' + stats.got + '）');
                finish();
                return;
            }
            setTimeout(poll, 200);
        })();
    }

    function step3(win) {
        var dst = cache[TEST_JP];
        check(!!dst, '② 宿主给出了译文', dst ? ('「' + dst.slice(0, 20) + '…」') : '空');

        // ③ 第二次绘制：必须换成宿主的译文
        win.contents.clear();
        win.drawText(TEST_JP, 0, 0, win.contents.width);
        check(drawn && drawn.substituted && drawn.used === dst,
            '③ 运行时回填：绘制时用的是宿主的译文', drawn ? ('「' + drawn.used.slice(0, 24) + '…」') : 'n/a');
        check(drawn && drawn.used.indexOf(MARK) === 0,
            '③ 译文确实来自宿主（带测试标记）', drawn ? drawn.used.slice(0, 12) : 'n/a');

        // ④ 旁证：钩子确实挂在游戏的真实绘制路径上（游戏自己的菜单/标签也会经过它）
        note('游戏自身绘制的文本数：' + stats.foreign);
        finish();
    }

    // ── 初始化 ───────────────────────────────────────────────────────
    note('插件已加载（' + (SELFTEST ? '自检模式' : '常驻模式') + '）');
    try { connectBus(); } catch (e) { note('连接总线异常：' + e.message); }
    setInterval(pump, 200);
    if (SELFTEST) setTimeout(waitReady, 300);
})();
