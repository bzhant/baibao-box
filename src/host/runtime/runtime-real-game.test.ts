import { afterAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireGameLock, startRuntimeSessionWith, type RuntimeHandle } from './index';

/**
 * **真实游戏**上的运行时链路验收（RPG Maker MV）。
 *
 * 为什么这条测试必须存在（只测玩具目标是不够的）：
 *   玩具目标是"可控的验证对象"，但它是我自己写的，我按自己的理解去 hook。
 *   真实引擎会立刻暴露"我以为的拦截点"和"引擎真实的绘制路径"之间的差距 ——
 *   MV/MZ 的文本全程在 JS 里，**编码层 hook 在这类引擎上看不见任何东西**，
 *   所以引擎侧的拦截点必须在 JS 层，装法也不同（可逆地装插件，不是注入 DLL）。
 *   这条测试跑的就是那条真实路径。
 *
 * 它断言什么（不是"命令发出去了"，而是"宿主的译文真的被画出来了"）：
 *   ① 桥在真实游戏里挂上真实绘制入口，并登记了词表外的原文；
 *   ② 宿主的译文到达（走总线，和原生侧同一套协议）；
 *   ③ **第二次绘制用的就是宿主的译文**（带只有宿主才可能给出的标记）；
 *   ④ 跑完游戏文件被**逐字节还原**（run.mjs 比对 SHA-256）。
 *
 * 怎么跑：
 *   BB_MV_SAMPLE="E:/path/to/mv-game" npx vitest run src/host/runtime/runtime-real-game.test.ts
 * 未设样本路径 / 非 Windows 时整组跳过（CI 友好）。
 */

const ROOT = resolve(__dirname, '../../..');
const RUNNER = join(ROOT, 'tools', 'mv-runtime', 'run.mjs');
const BRIDGE = join(ROOT, 'tools', 'mv-runtime', 'BB_RuntimeBridge.js');
/** run.mjs 默认产物名（已在 .gitignore 里） */
const RESULT = join(ROOT, 'bb_runtime_result.json');

process.env['BB_GAME_LOCK_TIMEOUT_MS'] = '900000'; // 真机测试互相抢同一个游戏目录 → 排队
const MV = process.env.BB_MV_SAMPLE ?? '__no_sample__';
const canRun =
  process.platform === 'win32' &&
  existsSync(RUNNER) &&
  existsSync(BRIDGE) &&
  existsSync(join(MV, 'www', 'js', 'rpg_core.js'));

/** 测试用的确定性"翻译"：加前缀，这样"译文是否来自宿主"一眼可验。 */
const MARK = '【中】';
const translator = async (items: { src: string }[]) =>
  items.map((i) => ({ src: i.src, dst: MARK + i.src }));

interface BridgeRun {
  code: number | null;
  stdout: string;
}

/** 跑一次 run.mjs（它会装插件 → 起游戏 → 收结果 → 逐字节还原）。 */
function runBridge(port: number): { child: ChildProcess; done: Promise<BridgeRun> } {
  const child = spawn(process.execPath, [RUNNER, MV, '--plugin', BRIDGE, '--timeout', '220000'], {
    cwd: ROOT,
    env: { ...process.env, BB_BUS_PORT: String(port) },
  });
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  child.stderr.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
  const done = new Promise<BridgeRun>((res) => child.on('close', (code) => res({ code, stdout })));
  return { child, done };
}

describe.skipIf(!canRun)('运行时注入 · 真实游戏（MV 运行时桥）', () => {
  let handle: RuntimeHandle | null = null;

  afterAll(async () => {
    if (handle) await handle.session.close();
  });

  it(
    '宿主在真实 MV 游戏的运行时里完成 取词 → 翻译 → 回填，且跑完逐字节还原',
    async () => {
      // ★ 动游戏目录前先拿**跨进程锁**：同一个游戏同时只能有一个会话在装/还原。
      //   这条测试走 run.mjs 自检路线（不经过产品服务），所以自己拿锁；
      //   否则会与"一键汉化"那条产品路径测试并行，互相把 plugins.js 装掉/还原掉。
      const lock = acquireGameLock(MV, {
        timeoutMs: Number(process.env['BB_GAME_LOCK_TIMEOUT_MS'] ?? 900000),
      });
      try {
      if (existsSync(RESULT)) rmSync(RESULT); // 从干净结果开始，免得读到上一轮的

      let run: ReturnType<typeof runBridge> | null = null;
      handle = await startRuntimeSessionWith({
        translator,
        stateDir: tmpdir(),
        clientTimeoutMs: 120_000, // 真实游戏启动到就绪可能 40 秒以上（见 mv-runtime/README 坑 2）
        activator: {
          async activate(ctx) {
            run = runBridge(ctx.port);
            return { detail: 'MV 运行时桥（可逆装插件）' };
          },
        },
      });

      // ★ 反向 RPC 必须**趁桥还在线**查 —— 桥自检完会自己退出游戏，
      //   等 run 结束再查只会拿到"没有第 N 号客户端"。
      const live = await handle.session.nativeStats();
      expect(live, '反向 RPC 没通（宿主 → 桥的 runtimeStat 没应答）').toBeTruthy();
      expect(live?.run, '桥应当处于启用状态').toBe(1);

      // 桥一连上，宿主就该开始收到取自真实游戏的取词请求
      const served = await waitFor(async () => {
        const s = await handle!.session.stats();
        return s.requested > 0 && s.translated > 0;
      }, 60_000);
      expect(served, '宿主没有收到/应答取自真实游戏的取词请求').toBe(true);

      // 等游戏跑完（桥自检结束后自己退出，run.mjs 再还原现场）
      const result = await run!.done;
      expect(result.code, `run.mjs 退出码非 0：\n${result.stdout.slice(-2000)}`).toBe(0);

      // ★ 可逆性：真实游戏文件必须逐字节还原（run.mjs 比对 sha256）
      expect(result.stdout, '没有看到"逐字节还原"的确认').toContain('已逐字节还原（sha256 一致）');

      // ── 桥自己的自述 ──
      expect(existsSync(RESULT), `桥没有产出结果文件 ${RESULT}\n${result.stdout.slice(-1500)}`).toBe(true);
      const data = JSON.parse(readFileSync(RESULT, 'utf8')).data as {
        checks: Array<{ pass: boolean; name: string; detail: string }>;
        pass: number;
        fail: number;
        passLine: string;
        stats: { seen: number; queued: number; got: number; applied: number; foreign: number };
        window?: { contentsWidth: number; fontFace: string };
      };
      const failed = data.checks.filter((c) => !c.pass);
      expect(failed, `桥自检有失败项：${JSON.stringify(failed, null, 2)}`).toHaveLength(0);
      expect(data.fail).toBe(0);

      // 桥确实在真实游戏里挂上了真实绘制入口（游戏自己的菜单/标签也会经过它）
      expect(data.stats.seen, '桥没有观察到任何绘制文本').toBeGreaterThan(0);
      expect(data.stats.applied, '桥一次都没有应用宿主给的译文').toBeGreaterThan(0);

      // ── 宿主这一侧的账本（与桥自己的统计对得上）──
      const stats = await handle.session.stats();
      expect(stats.requested).toBeGreaterThan(0);
      expect(stats.translated).toBeGreaterThan(0);

      // 把关键证据打到测试输出里，便于人工核对（不只是"绿了"）
      // eslint-disable-next-line no-console
      console.log(
        '[真实游戏验收] 桥自检：' + data.passLine +
        ' | 观察到绘制文本 ' + data.stats.seen + ' 条（游戏自身 ' + data.stats.foreign + ' 条）' +
        ' | 应用宿主译文 ' + data.stats.applied + ' 次' +
        ' | 窗口 contents.width=' + (data.window ? data.window.contentsWidth : '?') +
        ' 字体=' + (data.window ? data.window.fontFace : '?') +
        ' | 宿主侧账本：请求 ' + stats.requested + ' 条 / 有译文 ' + stats.translated + ' 条',
      );

      handle = null;
      } finally {
        lock.release();
      }
    },
    420_000,
  );
});

/** 轮询到条件成立或超时。 */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
}
