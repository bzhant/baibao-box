import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { logError, logInfo, logWarn } from '@platform/logbus';

/**
 * 用原生注入器把 hook 带进游戏进程 —— 运行时那条线的"落地动作"。
 *
 * 这层只做三件事：**判断位数 → 找到注入器 → 启动并解析结果**。
 * 具体怎么注入（挂起启动、shellcode 自举、看门狗）全在 native/injector 里，
 * 宿主侧不重复实现，也不猜它的内部状态 —— 只认它给出的**稳定契约**：
 * JSON 结果 + 退出码。
 */

/** 目标 PE 的位数。 */
export type PeArch = 'x86' | 'x64';

/**
 * 注入器的退出码 → 人话。
 *
 * 这份对应关系是 native/injector 的**稳定契约**（见 native/README.md），
 * 不要在宿主侧另创一套。改注入器退出码时必须同步这里。
 */
const EXIT_CODE_MESSAGES: Record<number, string> = {
  10: '参数错误',
  11: '目标有问题（文件不存在或不是合法的 PE）',
  12: 'DLL 有问题（不存在或不是合法的 PE）',
  13: '位数不匹配（32 位注入器注不进 64 位进程，反之亦然）',
  14: '在 DLL 里找不到入口导出（Install / _Install@4 / Install@4 都试过了）',
  15: '创建目标进程失败',
  16: '写入目标进程失败',
  17: '目标进程内执行失败',
  18: 'DLL 的 Install 返回了 FALSE（hook 没装上）',
  19: '超时',
  20: '进程不存在',
  21: '目标进程里没有我们的 DLL（无法卸载）',
  22: '卸载失败',
};

export function explainExitCode(code: number): string {
  return EXIT_CODE_MESSAGES[code] ?? `未知退出码 ${code}`;
}

/**
 * 读 PE 头判断目标位数。
 *
 * ★ 必须读文件头，**不能**按"宿主自己是几位的"去猜：
 *   64 位的宿主完全可以去注一个 32 位游戏，猜错就是退出码 13。
 */
export function detectPeArch(exePath: string): PeArch | null {
  if (!existsSync(exePath)) return null;
  const fd = openSync(exePath, 'r');
  try {
    const dos = Buffer.alloc(0x40);
    if (readSync(fd, dos, 0, 0x40, 0) < 0x40) return null;
    if (dos.readUInt16LE(0) !== 0x5a4d) return null; // 'MZ'
    const peOffset = dos.readUInt32LE(0x3c);
    const head = Buffer.alloc(6);
    if (readSync(fd, head, 0, 6, peOffset) < 6) return null;
    if (head.readUInt32LE(0) !== 0x0000_4550) return null; // 'PE\0\0'
    const machine = head.readUInt16LE(4);
    if (machine === 0x8664) return 'x64';
    if (machine === 0x014c) return 'x86';
    return null; // 其它架构（ARM64 等）本版本不支持
  } finally {
    closeSync(fd);
  }
}

/** 仓库里原生构建产物的根目录（`native/`）。 */
export function resolveNativeDir(explicit?: string): string | null {
  const candidates = [explicit, process.env.BB_NATIVE_DIR, join(process.cwd(), 'native')].filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  for (const dir of candidates) {
    if (existsSync(join(dir, 'build'))) return dir;
  }
  return null;
}

/** 按目标位数挑注入器：32 位的叫 bbInject32，64 位的叫 bbInject64。 */
export function resolveInjector(nativeDir: string, arch: PeArch): string {
  return join(nativeDir, 'build', arch, arch === 'x64' ? 'bbInject64.exe' : 'bbInject32.exe');
}

export interface InjectOutcome {
  ok: boolean;
  code: number;
  codeName: string;
  /** 目标进程号（注入成功时有） */
  pid: number | null;
  errors: string[];
  notes: string[];
  /** 失败时的人话解释 */
  message: string;
}

interface InjectorJson {
  ok?: boolean;
  code?: number;
  codeName?: string;
  errors?: string[];
  notes?: string[];
}

/** 从注入器的 notes 里取目标 pid（它是人话，所以用匹配而不是解析字段）。 */
function pickPid(notes: string[]): number | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const m = /pid=(\d+)/.exec(notes[i] ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

export interface LaunchInjectedOptions {
  /** 要启动的游戏 exe（绝对路径） */
  exe: string;
  /** 要注入的 hook DLL（绝对路径） */
  dll: string;
  nativeDir: string;
  /** 目标进程的工作目录（默认与 exe 同目录） */
  cwd?: string;
  timeoutMs?: number;
}

/**
 * 启动游戏并注入 hook。**成功返回时，游戏已经在带着 hook 运行了。**
 *
 * 注入器自己会先挂起启动、注入、再恢复执行，所以这个 Promise 返回时
 * 目标进程已经在跑 —— 宿主接下来只要等它连总线（握手）即可。
 */
export function launchInjected(opts: LaunchInjectedOptions): Promise<InjectOutcome> {
  const arch = detectPeArch(opts.exe);
  if (arch === null) {
    return Promise.resolve({
      ok: false,
      code: -1,
      codeName: 'BAD_TARGET',
      pid: null,
      errors: [],
      notes: [],
      message: `读不出目标位数：${opts.exe}（不是合法的 PE，或本版本不支持的架构）`,
    });
  }

  const injector = resolveInjector(opts.nativeDir, arch);
  if (!existsSync(injector)) {
    return Promise.resolve({
      ok: false,
      code: -1,
      codeName: 'NO_INJECTOR',
      pid: null,
      errors: [],
      notes: [],
      message: `找不到注入器 ${injector}（先在 native/ 里跑 node build.mjs）`,
    });
  }
  if (!existsSync(opts.dll)) {
    return Promise.resolve({
      ok: false,
      code: -1,
      codeName: 'NO_DLL',
      pid: null,
      errors: [],
      notes: [],
      message: `找不到 hook DLL ${opts.dll}`,
    });
  }

  const args = [
    '--exe',
    opts.exe,
    '--dll',
    opts.dll,
    '--cwd',
    opts.cwd ?? join(opts.exe, '..'),
    '--timeout',
    String(opts.timeoutMs ?? 15_000),
    '--json',
  ];
  logInfo('runtime', `注入启动：${arch} 目标=${opts.exe} hook=${opts.dll}`);

  return new Promise<InjectOutcome>((resolve) => {
    const child = spawn(injector, args, { cwd: join(injector, '..'), windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', (e) => {
      logError('runtime', `注入器无法启动：${e.message}`);
      resolve({
        ok: false,
        code: -1,
        codeName: 'SPAWN_FAILED',
        pid: null,
        errors: [e.message],
        notes: [],
        message: `注入器无法启动：${e.message}`,
      });
    });
    child.on('close', (code) => {
      const exit = code ?? -1;
      let parsed: InjectorJson = {};
      const start = out.indexOf('{');
      if (start >= 0) {
        try {
          parsed = JSON.parse(out.slice(start)) as InjectorJson;
        } catch {
          logWarn('runtime', '注入器输出不是合法 JSON，改用退出码判断');
        }
      }
      const outcome: InjectOutcome = {
        ok: parsed.ok === true && exit === 0,
        code: typeof parsed.code === 'number' ? parsed.code : exit,
        codeName: parsed.codeName ?? '',
        pid: pickPid(parsed.notes ?? []),
        errors: parsed.errors ?? (err ? [err.trim()] : []),
        notes: parsed.notes ?? [],
        message: exit === 0 ? '注入成功' : explainExitCode(exit),
      };
      if (outcome.ok) {
        logInfo('runtime', `注入成功，目标进程 pid=${outcome.pid}`);
      } else {
        logError('runtime', `注入失败（退出码 ${exit}，${outcome.message}）：${outcome.errors.join(' / ')}`);
      }
      resolve(outcome);
    });
  });
}

export interface UninjectOutcome {
  ok: boolean;
  message: string;
}

/**
 * 让已注入的进程执行 `Uninstall()`，把 hook 拆干净。
 *
 * 走注入器现成的 `--call` 通道 —— 宿主不自己造轮子去远端调用。
 */
export function uninject(pid: number, dll: string, nativeDir: string): Promise<UninjectOutcome> {
  const arch: PeArch = process.arch === 'ia32' ? 'x86' : 'x64';
  const injector = resolveInjector(nativeDir, arch);
  if (!existsSync(injector)) {
    return Promise.resolve({ ok: false, message: `找不到注入器 ${injector}` });
  }
  return new Promise<UninjectOutcome>((resolve) => {
    const child = spawn(
      injector,
      ['--call', String(pid), '--dll', dll, '--entry', 'Uninstall', '--json'],
      { cwd: join(injector, '..'), windowsHide: true },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.on('error', (e) => resolve({ ok: false, message: e.message }));
    child.on('close', (code) => {
      const ok = (code ?? -1) === 0 && out.includes('"ok":true');
      resolve({ ok, message: ok ? 'hook 已卸载' : `卸载失败（退出码 ${code}）：${out.slice(0, 200)}` });
    });
  });
}
