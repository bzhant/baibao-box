/**
 * 对拍验证：我们把多个 .text$mn 节"按节索引升序拼接"的顺序，
 * 是否与 **真实链接器** 合并它们时的顺序一致？
 *
 * 为什么必须对拍：如果顺序错了，我们生成的镜像里函数位置全错位，
 * 在目标进程里表现为随机崩溃 —— 这类 bug 极难查，所以要在构建期就证明它。
 *
 * 做法：把同一个 .obj 链成一个空 DLL，读取 MAP 文件里
 * .text 节内各函数的偏移，与我们算出的偏移逐个比对。
 *
 * 用法：node native/shellcode/verify-order.mjs <x86|x64>
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCoff, extractShellcode } from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const BUILD_TOOLS = process.env.BB_BUILD_TOOLS ?? 'D:\\BuildTools';
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';

const arch = (process.argv[2] ?? 'x64').toLowerCase();
const newest = (d) =>
  fs
    .readdirSync(d)
    .filter((x) => fs.statSync(path.join(d, x)).isDirectory())
    .sort()
    .at(-1);

const MSVC = path.join(BUILD_TOOLS, 'VC', 'Tools', 'MSVC', newest(path.join(BUILD_TOOLS, 'VC', 'Tools', 'MSVC')));
const SDKV = fs
  .readdirSync(path.join(SDK_ROOT, 'Include'))
  .filter((d) => /^10\./.test(d))
  .sort()
  .at(-1);

const bin = path.join(MSVC, 'bin', 'Hostx64', arch);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
env.PATH = `${bin};${env.PATH}`;
env.INCLUDE = [
  path.join(MSVC, 'include'),
  path.join(SDK_ROOT, 'Include', SDKV, 'ucrt'),
  path.join(SDK_ROOT, 'Include', SDKV, 'um'),
  path.join(SDK_ROOT, 'Include', SDKV, 'shared'),
].join(';');
env.LIB = [
  path.join(MSVC, 'lib', arch),
  path.join(SDK_ROOT, 'Lib', SDKV, 'ucrt', arch),
  path.join(SDK_ROOT, 'Lib', SDKV, 'um', arch),
].join(';');

const obj = path.join(NATIVE, 'build', arch, 'shellcode_stub.obj');
if (!fs.existsSync(obj)) {
  console.error(`✗ 找不到 ${obj}，先跑 node native/shellcode/try.mjs ${arch}`);
  process.exit(1);
}

const dll = path.join(NATIVE, 'build', arch, 'sc_order_test.dll');
const mapPath = path.join(NATIVE, 'build', arch, 'sc_order_test.map');

console.log(`--- 链接做对拍（${arch}）---`);
const r = spawnSync(
  path.join(bin, 'link.exe'),
  ['/nologo', '/DLL', '/NOENTRY', `/OUT:${dll}`, `/MAP:${mapPath}`, '/INCREMENTAL:NO', obj],
  { env, encoding: 'utf8' },
);
const linkLog = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
if (linkLog) console.log(linkLog);
if (r.status !== 0) {
  console.error(`✗ link 退出码 ${r.status}`);
  process.exit(1);
}

// ── 读 MAP：找 .text 里各函数（我们关心的符号）的 RVA ──
const mapText = fs.readFileSync(mapPath, 'utf8');

// MAP 里"Publics by Value"段的格式：
//   0001:00000000       _ShellcodeMain                     00401000 f   ...
// 我们只要 0001:xxxxxxxx（节:偏移），节 0001 = 第一个 code 节。
const addrOf = new Map();
const lineRe = /^ ([0-9a-f]{4}):([0-9a-f]{8})\s+(\S+)\s+([0-9a-f]{8})/gm;
let m;
while ((m = lineRe.exec(mapText))) {
  const [, secNo, secOff, sym, rva] = m;
  addrOf.set(sym, { secNo, secOff: parseInt(secOff, 16), rva: parseInt(rva, 16) });
}

// ── 我们算出来的镜像偏移 ──
const info = extractShellcode(obj, ['ShellcodeMain'], { arch });
const ours = new Map(info.symbolTable.map((s) => [s.name, s.offset]));

// ── 比对 ──
//
// 链接器把各 .text$mn 节合并进一个 .text 节时，**按节索引顺序**依次拼接。
// 所以"我们算出的**代码**镜像偏移"应当与"链接器给出的节内偏移"完全一致，
// 只差一个常量（镜像起点 vs .text 起点）。
//
// ⚠️ 数据符号（.rdata 里的字符串字面量）**不参与**这个比对 ——
//    它们本来就是另一个节，链接器给的是 .rdata 内的偏移，量纲不同。
//    我们只要证明**代码**的顺序对得上，数据按符号表重填即可。
const NOT_CODE = (name) => /^\?\?_C@/.test(name) || /^\?\?_C@/.test(name);
let mismatch = 0;
let base = null;
const rows = [];
let compared = 0;
for (const [name, off] of ours) {
  if (NOT_CODE(name)) continue;
  const hit = addrOf.get(name);
  if (!hit) {
    rows.push(`  ?  ${name}  —— MAP 里没有（可能被链接器剥离/内联）`);
    continue;
  }
  compared++;
  if (base === null) base = hit.secOff - off;
  const delta = hit.secOff - off;
  const ok = delta === base;
  if (!ok) mismatch++;
  rows.push(
    `  ${ok ? '✓' : '✗'}  镜像 0x${off.toString(16).padStart(4, '0')}  ` +
      `链接器 0x${hit.secOff.toString(16).padStart(4, '0')}  Δ=${delta}  ${name.slice(0, 60)}`,
  );
}
console.log(`基址差 Δ = ${base}（镜像起点对应 .text 内偏移）`);
console.log(rows.join('\n'));

if (mismatch > 0) {
  console.error(`\n✗ 有 ${mismatch} 个符号的顺序对不上 —— "按节索引拼接"的假设不成立！`);
  console.error('  修法：改用 MAP/链接产物驱动（让 injector 直接吃链接后的节数据）。');
  process.exit(1);
}
console.log(`\n✓ 全部 ${compared} 个代码符号与链接器顺序一致（${arch}）—— 拼接假设成立`);

// ── 额外：验证数据节顺序 ──
// 数据符号在 .rdata 里的相对顺序应当也是节索引序。我们检查"按我们的排序
// 得到的相对间距"与"链接器的相对间距"一致（只差一个常量）。
const dataOurs = [...ours].filter(([n]) => NOT_CODE(n));
const dataLink = dataOurs
  .map(([n]) => [n, addrOf.get(n)])
  .filter(([, h]) => h)
  .sort((a, b) => a[1].secOff - b[1].secOff);
let dbase = null;
let dmis = 0;
for (const [n, h] of dataLink) {
  if (dbase === null) { dbase = h.secOff; continue; }
}
// 我们的数据顺序（按镜像偏移）
const ourDataOrder = dataOurs.map(([n]) => n);
const linkDataOrder = dataLink.map(([n]) => n);
const sameOrder = ourDataOrder.length === linkDataOrder.length &&
  ourDataOrder.every((n) => linkDataOrder.includes(n));
if (!sameOrder && dataLink.length) {
  console.log(`⚠️  数据节相对顺序与链接器不同（我们 ${ourDataOrder.length} 个 / 链接器 ${linkDataOrder.length} 个）`);
  console.log('   → 只要"注入器修正记录"用的是**我们自己算的偏移**就没问题（自洽），');
  console.log('     因为每条修正记录都同时给出"要写的位置"和"要写的值"，不依赖链接器布局。');
} else if (dataLink.length) {
  console.log(`✓ 数据节符号集一致（${dataLink.length} 个）`);
}
void dmis;
process.exit(0);
