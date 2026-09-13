import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logWarn } from '@platform/logbus';

/**
 * 游戏目录锁 —— 同一个游戏同时只能有一个运行时汉化在跑。
 *
 * 为什么必须有（不是"测试才需要"）：
 *   运行时汉化要**改游戏文件**（装桥/还原）。两个进程同时干这件事会互相踩：
 *   一边刚装好、另一边还原了，于是"插件明明装了却没人连总线"；
 *   更糟的是两个进程各自备份 `plugins.js`，还原时互相覆盖。
 *
 *   真实场景就有两条入口：**界面点了「一键汉化并启动」**，用户又开着命令行 `--runtime`。
 *   所以锁要能跨进程，不能只在内存里判重。
 *
 * 做法：在临时目录建一个以游戏路径哈希命名的锁文件，内容写持有者 pid。
 *   · 已被占：读 pid，进程还活着就等（或按调用方要求直接失败）；进程已死则**抢占**
 *     —— 否则一次崩溃会让那个游戏永久锁死。
 *   · 锁文件只是"约定"，不是安全边界：我们做的是汉化工具，防的是自己踩自己。
 */

export interface GameLock {
  release(): void;
}

function lockPathFor(gameDir: string): string {
  const h = createHash('sha1').update(gameDir.toLowerCase()).digest('hex').slice(0, 16);
  return join(tmpdir(), `bb-game-${h}.lock`);
}

/** 进程是否还活着（只在拿锁/抢锁时用，不引入额外依赖） */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0 = 只探测存在性
    return true;
  } catch (e) {
    // EPERM = 存在但没权限（仍算活着）
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface AcquireOptions {
  /**
   * 等锁的最长时间（毫秒）。默认 0 = **不等待，直接失败**：
   * 用户又点了一次按钮时，应该立刻被告知"已经在汉化中"，而不是默默排队。
   * 自动化测试会用较大的值来把彼此串起来。
   */
  timeoutMs?: number;
  pollMs?: number;
}

export class GameLockedError extends Error {}

export function acquireGameLock(gameDir: string, opts: AcquireOptions = {}): GameLock {
  const path = lockPathFor(gameDir);
  const timeoutMs = opts.timeoutMs ?? 0;
  const pollMs = opts.pollMs ?? 300;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const fd = openSync(path, 'wx'); // 独占创建：已存在就 EEXIST
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return {
        release(): void {
          try {
            if (existsSync(path) && readFileSync(path, 'utf8').trim() === String(process.pid)) {
              unlinkSync(path);
            }
          } catch {
            /* 尽力而为 */
          }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // 已被占：看看持有者是否还活着
    let holder = 0;
    try {
      holder = Number(readFileSync(path, 'utf8').trim()) || 0;
    } catch {
      /* 读不到当作抢 */
    }
    if (!isAlive(holder)) {
      logWarn('runtime', `发现残留的游戏锁（持有进程 ${holder || '?'} 已不在），按抢占处理`);
      try {
        unlinkSync(path);
      } catch {
        /* 别人可能刚好也清了 */
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new GameLockedError(
        `这个游戏已经在汉化中（进程 ${holder}）。\n` +
          `       同一个游戏同时只能有一个运行时汉化 —— 请先关掉那个游戏/那个会话再试。`,
      );
    }
    sleepSync(pollMs);
  }
}

/** 同步小睡：拿锁是启动路径上的短操作，同步写起来不容易出错 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}
