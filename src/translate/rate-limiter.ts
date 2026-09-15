/**
 * 并发 + 速率限流器。
 *
 * 机翻接口都有配额（QPS / 并发上限）。一股脑全发出去会被限流甚至封号。
 * 这个类做两件事：
 *   1. **并发上限**：同一时刻最多 N 个任务在飞；
 *   2. **最小间隔**：两次"任务开始"之间至少隔 T 毫秒（限 QPS）。
 *
 * `runAll` 保序返回结果（第 i 个结果对应第 i 个任务）。
 */

export interface RateLimitOptions {
  /** 同一时刻最多在飞的任务数（默认 4） */
  maxConcurrent?: number;
  /** 两次任务开始之间的最小间隔毫秒（默认 0） */
  minIntervalMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private active = 0;
  private lastStart = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(opts: RateLimitOptions = {}) {
    const concurrency = opts.maxConcurrent ?? 4;
    const interval = opts.minIntervalMs ?? 0;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
    if (!Number.isFinite(interval) || interval < 0) throw new Error('Invalid rate interval');
    this.maxConcurrent = concurrency;
    this.minIntervalMs = interval;
  }

  private async acquire(): Promise<void> {
    while (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    const now = Date.now();
    // Reserve before awaiting so concurrent callers cannot share the same slot.
    const start = Math.max(now, this.lastStart + this.minIntervalMs);
    this.lastStart = start;
    if (start > now) await sleep(start - now);
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 执行单个任务（带限流） */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  /** 执行一组任务（带限流），保序返回 */
  async runAll<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
    const results = await Promise.allSettled(tasks.map((t) => this.run(t)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((r) => (r as PromiseFulfilledResult<T>).value);
  }

  /** 当前在飞任务数（测试/观测用） */
  get inflight(): number {
    return this.active;
  }
}
