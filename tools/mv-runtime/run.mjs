// ============================================================================
// MV 运行时插件 —— 可逆安装 / 运行 / 收集 / **逐字节还原**（一条命令）
// ============================================================================
// 用法：
//   node tools/mv-runtime/run.mjs "<游戏目录>" --plugin <js路径> [--plugin <js路径>...]
//                               [--timeout 60000] [--keep] [--out <结果文件名>]
//
// 例：
//   跑探针：node tools/mv-runtime/run.mjs "E:/game" --plugin tools/mv-runtime/BB_Probe.js
//   跑验收：node tools/mv-runtime/run.mjs "E:/game" \
//             --plugin src/engines/mvmz/runtime/BB_Layout.js \
//             --plugin tools/mv-runtime/BB_LayoutAccept.js --out bb_layout_accept.json
//
// 做的事（顺序不能乱）：
//   1. 备份 www/js/plugins.js（记 SHA-256）
//   2. 把所有 --plugin 拷进 www/js/plugins/，并在 plugins.js 末尾按顺序注册
//   3. 启动游戏（插件自己测量/自检后写结果并退出）
//   4. 读回结果 JSON 并打印
//   5. **还原**：plugins.js 恢复原字节、删掉拷进去的插件、**校验 SHA-256 一致**
//
// ★ 为什么坚持"逐字节校验还原"
//   工程铁律是"改前先备份、必须可逆"。但"执行了还原"和"还原对了"是两件事：
//   少一个字节、多一个 BOM，都可能让游戏之后出问题而没人发现。
//   所以这里比对 SHA-256，不一致就以非 0 退出码报错，绝不静默放过。
//
// ★ 为什么做成通用的 --plugin 入口，而不是写死插件名
//   探针（BB_Probe）与验收（BB_LayoutAccept）要装的插件不同，而且验收还要
//   同时装**被测的那个插件**。做成通用入口，两边共用同一套
//   "备份/安装/运行/收集/还原"逻辑，就不会出现"某条路径忘了还原"。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 参数解析 ──
const args = process.argv.slice(2);
const plugins = [];
let gameDir = null;
// 默认放宽到 200 秒：实测某些 MV 游戏启动到就绪可能要 40 秒以上（见 README）
let timeoutMs = 200000;
let keep = false;
let outName = 'bb_runtime_result.json';

for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--plugin') plugins.push(args[++i]);
    else if (a === '--timeout') timeoutMs = Number(args[++i]) || 200000;
    else if (a === '--out') outName = args[++i];
    else if (a === '--keep') keep = true;
    else if (!a.startsWith('--') && gameDir === null) gameDir = a;
}

if (!gameDir || plugins.length === 0) {
    console.error('用法：node tools/mv-runtime/run.mjs "<游戏目录>" --plugin <js路径> [--plugin ...] [--timeout ms] [--keep] [--out 名字]');
    process.exit(2);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const die = (msg) => { console.error('\n[失败] ' + msg); process.exit(1); };

// ── 0) 定位 www / plugins.js / Game.exe ──
//
// 兼容两种布局与两代引擎：
//   MV：`www/js/rpg_core.js`（发布态带 www）或 `js/rpg_core.js`（项目态）
//   MZ：`js/rmmz_core.js`（MZ 一律是根布局，没有 www）
// 两代引擎的 plugins.js / plugins/ 位置完全相同，所以后续逻辑可以共用。
const CORE_CANDIDATES = [
    ['www/js/rpg_core.js', 'MV'],
    ['js/rpg_core.js', 'MV'],
    ['www/js/rmmz_core.js', 'MZ'],
    ['js/rmmz_core.js', 'MZ'],
];
let wwwDir = null;
let engine = null;
for (const [rel, name] of CORE_CANDIDATES) {
    const p = path.join(gameDir, rel);
    if (fs.existsSync(p)) {
        wwwDir = path.dirname(path.dirname(p));
        engine = name;
        break;
    }
}
if (!wwwDir) {
    die(`在 "${gameDir}" 里既找不到 MV 的 js/rpg_core.js，也找不到 MZ 的 js/rmmz_core.js`);
}

const pluginsJs = path.join(wwwDir, 'js', 'plugins.js');
const pluginsDir = path.join(wwwDir, 'js', 'plugins');
const exePath = path.join(gameDir, 'Game.exe');
if (!fs.existsSync(pluginsJs)) die(`找不到 ${pluginsJs}`);
if (!fs.existsSync(exePath)) die(`找不到 ${exePath}`);

console.log('=== RPG Maker 运行时插件加载器 ===');
console.log('引擎     : ' + engine);
console.log('游戏目录 : ' + gameDir);
console.log('www      : ' + wwwDir);
console.log('插件     : ' + plugins.join(', '));

// ── 1) 备份 ──
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mv-rt-'));
const backupPlugins = path.join(backupDir, 'plugins.js.orig');
const origBytes = fs.readFileSync(pluginsJs);
fs.writeFileSync(backupPlugins, origBytes);
const origHash = sha256(origBytes);
console.log('\n[1/5] 已备份 plugins.js（' + origBytes.length + ' 字节，sha256=' + origHash.slice(0, 16) + '…）');

let restored = false;
function restore() {
    if (restored) return;
    restored = true;
    console.log('\n[5/5] 还原游戏文件');
    let okAll = true;
    try {
        fs.copyFileSync(backupPlugins, pluginsJs);
        const nowHash = sha256(fs.readFileSync(pluginsJs));
        if (nowHash !== origHash) {
            console.error('  ✗ plugins.js 还原后哈希不一致！期望 ' + origHash + '，实际 ' + nowHash);
            console.error('    → 备份仍在 ' + backupPlugins);
            okAll = false;
        } else {
            console.log('  ✓ plugins.js 已逐字节还原（sha256 一致）');
        }
    } catch (e) {
        console.error('  ✗ 还原 plugins.js 失败：' + e.message);
        console.error('    → 备份在 ' + backupPlugins);
        okAll = false;
    }
    for (const p of plugins) {
        const dst = path.join(pluginsDir, path.basename(p));
        try {
            if (fs.existsSync(dst)) { fs.unlinkSync(dst); console.log('  ✓ 已删除 ' + path.basename(p)); }
        } catch (e) {
            console.error('  ✗ 删除 ' + path.basename(p) + ' 失败：' + e.message);
            okAll = false;
        }
    }
    try {
        if (keep) {
            console.log('  (--keep：保留备份目录 ' + backupDir + ')');
        } else if (okAll) {
            fs.rmSync(backupDir, { recursive: true, force: true });
            console.log('  ✓ 现场已完全复原，备份目录已清理');
        } else {
            console.log('  ! 现场未完全复原，备份保留在 ' + backupDir);
        }
    } catch (e) { /* 清理失败不算致命 */ }
    if (!okAll) process.exitCode = 1;
}
process.on('exit', restore);
process.on('SIGINT', () => { restore(); process.exit(130); });

// ── 2) 安装 ──
//
// ★★ 装之前先检查"目标位置有没有同名文件" ★★
//   这是一条真实存在的风险，不是假想：本机这个游戏自己就有两个以 `BB_` 开头的
//   插件（`BB_CenterSlide.js` / `BB_EnemyPositionYMax.js`）。
//   如果我们要装的插件恰好和游戏自己的插件**同名**，那就会：
//     覆盖它 → 跑完把它删掉 → **把游戏自己的插件永久删了**。
//   虽然还原逻辑会删"我们装进去的"文件，但那时它已经是游戏的文件了。
//   所以这里直接**拒绝**：同名就报错退出，不冒险。
//   （用内容比对放行唯一一种安全情形：同名且逐字节相同 —— 那就无所谓覆盖。）
const installed = [];
for (const p of plugins) {
    if (!fs.existsSync(p)) die(`找不到插件文件 ${p}`);
    const name = path.basename(p);
    const dst = path.join(pluginsDir, name);
    if (fs.existsSync(dst)) {
        const same = sha256(fs.readFileSync(dst)) === sha256(fs.readFileSync(p));
        if (!same) {
            die(`游戏目录里已存在同名插件 ${name} 且内容不同。\n` +
                `       拒绝安装 —— 否则跑完会把它误删（那会破坏游戏）。\n` +
                `       位置：${dst}\n` +
                `       请把我们的插件改成别的名字再试。`);
        }
        console.log(`      （${name} 已存在且内容相同，跳过拷贝）`);
    } else {
        fs.copyFileSync(p, dst);
    }
    installed.push(name.replace(/\.js$/, ''));
}
const srcText = fs.readFileSync(pluginsJs, 'utf8');
const arrEnd = srcText.lastIndexOf(']');
if (arrEnd < 0) die('plugins.js 里找不到 $plugins 数组的结尾 `]`');
// ⚠️ 用"字符串追加"而不是 JSON.parse/stringify 重写整个 plugins.js ——
//    后者会把游戏原有的注释与格式全改掉。能不动就不动，少一次出错机会。
const entries = installed.map((n) =>
    '\n{"name":"' + n + '","status":true,"description":"BB runtime (temporary)","parameters":{"Enabled":"true"}}\n').join(',');
const newText = srcText.slice(0, arrEnd).replace(/[\s,]*$/, '') + ',' + entries + srcText.slice(arrEnd);
fs.writeFileSync(pluginsJs, newText, 'utf8');
console.log('\n[2/5] 已安装并注册：' + installed.join(', ') +
    '（+' + (newText.length - srcText.length) + ' 字节）');

// ── 3) 运行 ──
const outJson = path.join(backupDir, outName);
console.log('\n[3/5] 启动游戏（插件自检后会写结果并自行退出，上限 ' + timeoutMs + 'ms）');
const started = Date.now();
// ★★ 传"禁用后台节流"的 Chromium 开关 ★★
//   实测现象：游戏启动后 `$dataSystem` 一直是 null、`SceneManager._scene` 也是 null、
//   而且**不报任何错** —— 看起来像"游戏起不来"。真实原因是：
//   NW.js（Chromium）对**不在前台/被遮挡**的窗口会**节流 requestAnimationFrame**，
//   而 MV/MZ 的启动流程是 `Scene_Boot.start()` 加载数据库、再由
//   `Scene_Boot.update()`（靠 rAF 驱动）检查"加载完了没"才 goto(Scene_Title)。
//   rAF 被节流 → update 不跑 → 永远不就绪。
//   用户手动点一下窗口把它激活，一切就正常了 —— 这解释了之前"同一游戏
//   启动耗时在 2 秒到 300 秒以上之间摇摆"的全部现象。
//   这三个开关正是用来关掉这类节流的。
const CHROMIUM_FLAGS = [
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
];

const child = spawn(exePath, CHROMIUM_FLAGS, {
    cwd: gameDir,
    env: { ...process.env, BB_PROBE_OUT: outJson },
    stdio: 'ignore',
});
console.log('      pid = ' + child.pid);

const outcome = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
        if (fs.existsSync(outJson)) return resolve('ok');
        if (Date.now() - t0 > timeoutMs) return resolve('timeout');
        setTimeout(tick, 400);
    };
    tick();
});
console.log('      结果：' + outcome + '（用时 ' + ((Date.now() - started) / 1000).toFixed(1) + ' 秒）');

try {
    if (child.exitCode === null && !child.killed) {
        console.log('      插件未自行退出，正在结束进程树…');
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
} catch (e) { /* 尽力而为 */ }

// ── 4) 收集 ──
console.log('\n[4/5] 收集结果');
if (!fs.existsSync(outJson)) {
    console.error('  ✗ 没有产出结果文件（游戏没起来 / 插件没加载 / 插件抛异常）');
    process.exitCode = 1;
} else {
    const j = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    if (!j.ok) {
        console.error('  ✗ 插件自身报错：' + j.error);
        process.exitCode = 1;
    } else {
        console.log('  ✓ 插件执行成功\n');
        console.log(JSON.stringify(j.data, null, 2));
        if (j.error) console.log('\n  (附注：' + j.error + ')');
        const dst = path.join(process.cwd(), outName);
        try { fs.copyFileSync(outJson, dst); console.log('\n  结果已另存：' + dst); } catch (e) {}
        if (j.data && typeof j.data.fail === 'number' && j.data.fail > 0) {
            console.error('\n  ✗ 验收有失败项：' + j.data.passLine);
            process.exitCode = 1;
        }
    }
}
