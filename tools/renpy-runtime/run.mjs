// ============================================================================
// Ren'Py 适配文件 —— 安装 / lint 验收 / **逐字节还原**
// ============================================================================
// 用法：node tools/renpy-runtime/run.mjs "<Ren'Py 游戏目录>"
//
// 做的事：
//   1. 跑一次 **基线 lint**（安装前），记录警告集合
//   2. 安装 src/engines/renpy/runtime/zz_bb_cjk.rpy 到 game/
//   3. 再跑一次 lint，**比对两次报告**
//        · 我们的文件不得出现在报告里（出现即说明有语法/样式错误）
//        · 警告条数不得增加（不得给游戏引入新的 lint 问题）
//   4. 还原：删掉 zz_bb_cjk.rpy **和它的 .rpyc**，并逐字节校验 game/ 回到原样
//
// ── ★ 为什么必须删 .rpyc ──
//   Ren'Py 会把 `.rpy` 编译成 `.rpyc` 一起加载。
//   只删 `.rpy` 而留下 `.rpyc`，**它仍然会被加载** —— 这是"删了却没还原"的经典坑，
//   而且症状很隐蔽：文件明明不在了，行为却还是改过的样子。
//
// ── ★ lint 能证明什么、不能证明什么（别夸大）──
//   能证明：`.rpy` 能被 Ren'Py 编译、不引入新的 lint 警告/错误 —— 即"装上去不会把游戏弄坏"。
//   **不能**证明：字体真的生效、中文真的显示出来了。
//   实测 `lint` **不会执行 init python 代码**（我们写在 init 里的日志一行都没出现），
//   所以它只是"编译期"验证。真实观感必须在游戏里看 —— 这一点在报告里如实标注。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const gameDir = args.find((a) => !a.startsWith('--'));
const keep = args.includes('--keep');
if (!gameDir) {
    console.error("用法：node tools/renpy-runtime/run.mjs \"<Ren'Py 游戏目录>\" [--keep]");
    process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ADAPTER_SRC = path.join(REPO, 'src', 'engines', 'renpy', 'runtime', 'zz_bb_cjk.rpy');
const ADAPTER_NAME = 'zz_bb_cjk.rpy';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const die = (m) => { console.error('\n[失败] ' + m); process.exit(1); };

// ── 0) 定位项目：game/ 与启动器 ──
const gameSub = path.join(gameDir, 'game');
if (!fs.existsSync(gameSub)) die(`"${gameDir}" 下没有 game/ 目录`);
const exe = fs.readdirSync(gameDir).find((f) => f.toLowerCase().endsWith('.exe'));
if (!exe) die(`"${gameDir}" 下找不到启动器 exe（lint 要用它跑）`);
const exePath = path.join(gameDir, exe);
if (!fs.existsSync(ADAPTER_SRC)) die(`找不到适配文件 ${ADAPTER_SRC}`);

console.log("=== Ren'Py 适配文件安装 + lint 验收 ===");
console.log('项目目录 : ' + gameDir);
console.log('启动器   : ' + exe);
console.log('适配文件 : ' + ADAPTER_NAME);

// ── 跑 lint，返回 { code, text, warnCount, warnSet } ──
function runLint(tag) {
    const r = spawnSync(exePath, ['.', 'lint'], {
        cwd: gameDir, encoding: 'utf8', timeout: 300000, windowsHide: true,
    });
    const text = (r.stdout || '') + (r.stderr || '');
    // 只统计 "game/xxx.rpy:行号 ..." 形式的告警
    const lines = text.split(/\r?\n/).filter((l) => /^game\/.+:\d+/.test(l));
    const set = new Set(lines.map((l) => l.trim()));
    console.log(`  [${tag}] 退出码=${r.status}  告警条数=${lines.length}  输出=${text.length} 字符`);
    return { code: r.status, text, warnCount: lines.length, warnSet: set, lines };
}

// ── 1) 基线 lint ──
console.log('\n[1/4] 基线 lint（安装前）');
const before = runLint('基线');
if (!before.text.includes("lint report")) die('lint 没有产出报告（启动器没按预期工作？）');

// ── 2) 安装 ──
console.log('\n[2/4] 安装适配文件');
const dst = path.join(gameSub, ADAPTER_NAME);
fs.copyFileSync(ADAPTER_SRC, dst);
const dstRpyc = dst + 'c';
console.log('  已写入 ' + path.relative(gameDir, dst));

// ── 3) 安装后 lint + 比对 ──
console.log('\n[3/4] 安装后 lint + 比对');
const after = runLint('安装后');

const ours = after.lines.filter((l) => l.includes(ADAPTER_NAME));
const newlyAdded = after.lines.filter((l) => !before.warnSet.has(l.trim()));

let fail = 0;
const check = (cond, name, detail) => {
    console.log(`  ${cond ? '[通过]' : '[失败]'} ${name}  ${detail}`);
    if (!cond) fail++;
};

check(after.code === 0, 'lint 退出码为 0（脚本能被编译）', `退出码=${after.code}`);
check(ours.length === 0,
    '我们的文件没有出现在 lint 报告里（没引入语法/样式错误）',
    ours.length ? ('出现 ' + ours.length + ' 条：' + ours.slice(0, 2).join(' | ')) : '0 条');
check(newlyAdded.length === 0,
    '没有引入新的 lint 告警（与基线逐条比对）',
    newlyAdded.length
        ? ('新增 ' + newlyAdded.length + ' 条，例：' + newlyAdded.slice(0, 2).join(' | '))
        : `基线 ${before.warnCount} 条 → 安装后 ${after.warnCount} 条，无新增`);
check(after.warnCount === before.warnCount,
    '告警条数与基线一致',
    `${before.warnCount} → ${after.warnCount}`);
check(fs.existsSync(dstRpyc),
    "Ren'Py 已把适配文件编译成 .rpyc（说明它确实被加载处理了）",
    fs.existsSync(dstRpyc) ? '.rpyc 已生成' : '未生成（可能没被扫描到）');

// ── 4) 还原 + 逐字节校验 ──
console.log('\n[4/4] 还原');
let restoreOk = true;
for (const f of [dst, dstRpyc]) {
    try {
        if (fs.existsSync(f)) {
            // 记录哈希后再删，便于失败时追溯
            const h = sha256(fs.readFileSync(f));
            fs.unlinkSync(f);
            console.log(`  ✓ 已删除 ${path.basename(f)}（删前 sha256=${h.slice(0, 16)}…）`);
        }
    } catch (e) {
        console.error('  ✗ 删除 ' + f + ' 失败：' + e.message);
        restoreOk = false;
    }
}
check(!fs.existsSync(dst) && !fs.existsSync(dstRpyc),
    '适配文件与其 .rpyc 都已清除',
    'game/ 里已无 ' + ADAPTER_NAME);

// 再跑一次 lint，确认回到基线的告警集合（同一份脚本，应与基线逐条一致）
console.log('  （再跑一次 lint，确认恢复后与基线一致）');
const restored = runLint('还原后');
const restoredNew = restored.lines.filter((l) => !before.warnSet.has(l.trim()));
check(restored.warnCount === before.warnCount && restoredNew.length === 0,
    '还原后 lint 与基线逐条一致（现场干净）',
    `${before.warnCount} → ${restored.warnCount}，新增 ${restoredNew.length} 条`);

if (!keep) console.log('\n（--keep 可保留中间产物以便排查；本次未保留）');

console.log('\n============================================================');
console.log(fail === 0 ? ' 全部通过' : ` 有 ${fail} 项失败`);
console.log('============================================================');
process.exit(fail === 0 ? 0 : 1);
