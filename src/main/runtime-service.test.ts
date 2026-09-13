import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranslationProvider } from '@shared/contracts';
import { lastRuntimeSummary, startRuntime, stopRuntime, whenRuntimeStopped } from './runtime-service';

/**
 * **一键汉化**的端到端验收（真实游戏）：
 *   `startRuntime(游戏目录)` → 游戏启动 → 运行时逐帧取词 → 宿主用配置的接口翻译 → 桥回填
 *   → 收尾（关游戏/主动停）→ **游戏文件逐字节还原**。
 *
 * 为什么这条测试最重要：它是用户按一次按钮就走的那条路。
 * 之前验过的是"玩具目标"和"用 run.mjs 装插件的自检"，都不是产品路径；
 * 这条走的是真正的产品编排（`runtime-service` —— 命令行与界面共用同一套）。
 *
 * 断言策略（不看截图）：回填发生在**游戏进程内部**，所以以桥自己写的日志为准 ——
 *   `取词应答：N/M 条有译文（累计 got=… apply=…）` 里的 `apply` 才是"真的换掉了"的次数。
 *   `apply > 0` 才说明"游戏里显示的是译文"，而不是"消息发出去了"。
 *
 * 怎么跑：
 *   BB_MV_SAMPLE="E:/path/to/mv-game" npx vitest run src/main/runtime-service.test.ts
 * 未设样本 / 非 Windows 时整组跳过。
 */

process.env['BB_GAME_LOCK_TIMEOUT_MS'] = '900000'; // 真机测试互相抢同一个游戏目录 → 排队
const MV = process.env.BB_MV_SAMPLE ?? '__no_sample__';
const PLUGINS = join(MV, 'www', 'js', 'plugins.js');
const canRun = process.platform === 'win32' && existsSync(PLUGINS);

const sha256 = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * 测试专用用户数据目录 —— 绝不写进用户真实的译文库
 * （否则"假机翻"的译文会污染那款游戏真实积累的译文）。
 */
const tmpUserData = mkdtempSync(join(tmpdir(), 'bb-runtime-svc-'));
process.env['BB_USER_DATA_DIR'] = tmpUserData;
// 真机测试会互相抢同一个游戏目录 → 让它们**排队**而不是直接失败
process.env['BB_GAME_LOCK_TIMEOUT_MS'] = '900000';

/** 测试用的确定性"翻译"：加前缀 `【中】`，一眼可验、不依赖外部接口与密钥 */
const stub: TranslationProvider = {
  id: 'stub',
  displayName: '本地假机翻（测试）',
  offline: true,
  async translate(reqs) {
    return reqs.map((r) => ({ id: r.id, translated: '【中】' + r.source, provider: 'stub' }));
  },
};
const PROVIDER = { provider: stub, providerName: stub.displayName };

async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}

function bridgeTail(path: string, n = 1500): string {
  return existsSync(path) ? readFileSync(path, 'utf8').slice(-n) : '(桥日志不存在)';
}

/** 从桥日志里取某个计数的最大值（形如 `apply=12`） */
function bridgeCounter(logPath: string, key: string): number {
  if (!existsSync(logPath)) return 0;
  const all = readFileSync(logPath, 'utf8');
  const ms = [...all.matchAll(new RegExp(`${key}=(\\d+)`, 'g'))];
  return ms.length === 0 ? 0 : Math.max(...ms.map((m) => Number(m[1])));
}

/** 跑一次一键汉化并拿到统计。**成败都保证收尾**，不给下一个用例留现场。 */
async function runOneClick(): Promise<{
  bridgeLog: string;
  storeSize: number;
  requested: number;
  localHits: number;
}> {
  let bridgeLog = '';
  try {
    const r = await startRuntime({ gameDir: MV, ...PROVIDER });
    bridgeLog = r.bridgeLog;
    // ★ 等待必须给足：这个样本 3.4 GB / 140+ 插件，实测启动到画出标题界面的文本
    //   要 ~90 秒（热缓存会快些）。等太短会误判成"回填没发生"。
    const applied = await waitFor(() => bridgeCounter(bridgeLog, 'apply') > 0, 240_000);
    expect(
      applied,
      `游戏里的文本没有被换成译文（apply=0）。\n桥日志尾部：\n${bridgeTail(bridgeLog)}`,
    ).toBe(true);
  } finally {
    await stopRuntime().catch(() => undefined);
    await whenRuntimeStopped();
  }
  const s = lastRuntimeSummary();
  return {
    bridgeLog,
    storeSize: s?.storeSize ?? 0,
    requested: s?.requested ?? 0,
    localHits: s?.localHits ?? 0,
  };
}

describe.skipIf(!canRun)('一键汉化 · 运行时（真实游戏）', () => {
  afterAll(async () => {
    await stopRuntime().catch(() => undefined);
    try {
      rmSync(tmpUserData, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  });

  it(
    '启动即汉化：真实游戏的文本在运行时被换掉，收尾后游戏文件逐字节还原',
    async () => {
      const before = sha256(PLUGINS);
      const r = await runOneClick();

      expect(r.requested, '宿主没有收到取词请求').toBeGreaterThan(0);
      expect(r.storeSize, '译文库应当是空的（没积累译文）').toBeGreaterThan(0);
      expect(sha256(PLUGINS), 'plugins.js 没有逐字节还原 —— "改动可逆"这条红线破了').toBe(before);
    },
    420_000,
  );

  it(
    '第二次启动命中本地译文库（不再调用接口、瞬时汉化）',
    async () => {
      const r = await runOneClick();
      expect(r.localHits, '第二次启动没有命中任何本地译文（译文库没起作用）').toBeGreaterThan(0);
    },
    420_000,
  );
});
