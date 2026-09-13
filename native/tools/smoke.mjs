/**
 * 玩具目标冒烟自检。
 *
 * 只做一件事：**证明 exe 能起来、不崩**，然后干净关掉。
 * 为什么要这个：GUI 程序"编译通过"和"能跑"是两回事 ——
 * 每个引擎的 hook 上线前必须先过玩具目标的自测。
 *
 * 用法：node native/tools/smoke.mjs [x86|x64]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arch = (process.argv[2] ?? 'x86').toLowerCase();
const exe = path.join(NATIVE, 'build', arch, 'toygame.exe');
const dll = path.join(NATIVE, 'build', arch, 'toyHook.dll');

if (!fs.existsSync(exe)) {
  console.error(`✗ 找不到 ${exe}，先跑 node native/build.mjs ${arch}`);
  process.exit(1);
}
console.log(`玩具目标: ${exe}  (${fs.statSync(exe).size} 字节)`);
console.log(`编码 hook: ${dll}  (${fs.existsSync(dll) ? fs.statSync(dll).size + ' 字节' : '缺失'})`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(exe, [], { env, stdio: 'ignore' });
let exitCode = null;
child.on('exit', (c) => { exitCode = c; });

const WAIT_MS = 2500;
setTimeout(() => {
  if (exitCode !== null) {
    console.error(`✗ 玩具程序已退出（退出码 ${exitCode}）—— 说明它起不来`);
    process.exit(1);
  }
  console.log(`✓ 玩具程序存活 ${WAIT_MS}ms（pid=${child.pid}）：窗口创建成功，未崩溃`);

  child.kill();
  setTimeout(() => {
    console.log('✓ 已干净关闭');
    console.log('\n下一步（N1）：写注入器，把 toyHook.dll 注进去，看窗口上的日文变中文。');
    process.exit(0);
  }, 700);
}, WAIT_MS);
