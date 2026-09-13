/**
 * 单独编译 shellcode_stub.cpp 并抽取机器码（先跑通这条最险的路）。
 *
 * 用法：node native/shellcode/try.mjs [x86|x64]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractShellcode, emitHeader } from './extract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NATIVE = path.resolve(HERE, '..');
const BUILD_TOOLS = process.env.BB_BUILD_TOOLS ?? 'D:\\BuildTools';
const SDK_ROOT = 'C:\\Program Files (x86)\\Windows Kits\\10';

function newestDir(base) {
  const vs = fs.readdirSync(base).filter((d) => fs.statSync(path.join(base, d)).isDirectory());
  return path.join(base, vs.sort().at(-1));
}
const MSVC = newestDir(path.join(BUILD_TOOLS, 'VC', 'Tools', 'MSVC'));
const SDK_VER = fs
  .readdirSync(path.join(SDK_ROOT, 'Include'))
  .filter((d) => /^10\./.test(d))
  .sort()
  .at(-1);

function envFor(arch) {
  const msvcBin = path.join(MSVC, 'bin', 'Hostx64', arch);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.PATH = `${msvcBin};${env.PATH}`;
  env.INCLUDE = [
    path.join(MSVC, 'include'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'ucrt'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'um'),
    path.join(SDK_ROOT, 'Include', SDK_VER, 'shared'),
  ].join(';');
  return { env, cl: path.join(msvcBin, 'cl.exe') };
}

const arch = (process.argv[2] ?? 'x86').toLowerCase();
const { env, cl } = envFor(arch);
const out = path.join(NATIVE, 'build', arch);
fs.mkdirSync(out, { recursive: true });
const obj = path.join(out, 'shellcode_stub.obj');

console.log(`\n--- 编译 shellcode stub (${arch}) ---`);
const r = spawnSync(
  cl,
  [
    '/nologo', '/c', '/O2',
    '/GS-',            // 不要 __security_check_cookie（它是 CRT 调用，shellcode 里没有）
    '/GR-',            // 不要 RTTI
    '/EHs-c-',         // 不要异常处理表（.xdata 会在目标进程里指向错的位置）
    '/Gy-',            // 不要函数级 COMDAT（保证 .text 是一整块连续代码）
    '/Zl',             // 不写默认库引用
    '/utf-8',
    '/D_CRT_SECURE_NO_WARNINGS', '/DUNICODE', '/D_UNICODE',
    `/I${path.join(NATIVE, 'common')}`,
    `/I${HERE}`,
    `/Fo:${obj}`,
    path.join(HERE, 'shellcode_stub.cpp'),
  ],
  { env, encoding: 'utf8' },
);
const log = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
if (log) console.log(log);
if (r.status !== 0) {
  console.error(`[失败] 编译退出码 ${r.status}`);
  process.exit(1);
}

console.log('\n--- 抽取机器码 ---');
try {
  const info = extractShellcode(obj, ['ShellcodeMain'], { arch });
  console.log(`镜像 ${info.bytes.length} 字节（代码 ${info.codeSize} 字节）`);
  console.log(`入口 ${info.entryName} @ 0x${info.entryOffset.toString(16)}`);
  console.log('代码节（已按链接顺序拼接）：');
  for (const s of info.codeSections) {
    console.log(`  @0x${s.imageOffset.toString(16).padStart(4, '0')}  ${s.name.padEnd(12)} ${s.size} 字节`);
  }
  console.log('数据节：');
  for (const s of info.dataSections) {
    console.log(`  @0x${s.imageOffset.toString(16).padStart(4, '0')}  ${s.name.padEnd(12)} ${s.size} 字节`);
  }
  console.log(`需要修正的绝对地址：${info.fixes.length} 处`);
  for (const f of info.fixes) {
    console.log(`  @0x${f.at.toString(16)}  ${f.size} 字节 → 镜像 0x${f.targetImageOffset.toString(16)}  ${f.what}`);
  }
  const header = emitHeader(info);
  const hPath = path.join(HERE, `shellcode_${arch}.h`);
  fs.writeFileSync(hPath, header, 'utf8');
  console.log(`✓ 已写出 ${path.relative(process.cwd(), hPath)}`);
} catch (err) {
  console.error(`[失败] ${err.message}`);
  process.exit(1);
}
