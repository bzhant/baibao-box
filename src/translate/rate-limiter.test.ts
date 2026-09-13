import { describe, it, expect } from 'vitest';
import { RateLimiter } from './rate-limiter';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('RateLimiter', () => {
  it('并发不超过上限', async () => {
    const rl = new RateLimiter({ maxConcurrent: 2 });
    let active = 0;
    let maxActive = 0;
    const mk = (ms: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await sleep(ms);
      active--;
      return 1;
    };
    await rl.runAll([mk(40), mk(40), mk(40), mk(40), mk(40)]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('结果保序', async () => {
    const rl = new RateLimiter({ maxConcurrent: 2 });
    // 故意让早提交的任务更慢，验证返回顺序仍与提交一致
    const tasks = [30, 10, 20, 5].map((ms, i) => async () => {
      await sleep(ms);
      return i;
    });
    const out = await rl.runAll(tasks);
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('遵守最小开始间隔（限 QPS）', async () => {
    const rl = new RateLimiter({ maxConcurrent: 1, minIntervalMs: 60 });
    const starts: number[] = [];
    const mk = async () => {
      starts.push(Date.now());
      await sleep(5);
    };
    await rl.runAll([mk, mk, mk]);
    expect(starts).toHaveLength(3);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(55); // 容差
    }
  });

  it('单任务异常不影响其它任务', async () => {
    const rl = new RateLimiter({ maxConcurrent: 2 });
    const results = await Promise.allSettled([
      rl.run(async () => { throw new Error('boom'); }),
      rl.run(async () => 'ok'),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });
});
