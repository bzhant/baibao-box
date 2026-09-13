import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startRuntimeSession, type RuntimeHandle } from './index';

/**
 * **端到端**：宿主驱动原生注入，跑通「运行时取词 → 宿主翻译 → 回填进游戏」。
 *
 * 这条测试要证明的**不是**"命令发出去了"，而是：
 *   ① 宿主收到了热路径上的取词请求（不是只拿到离线词表）；
 *   ② 宿主给出的译文**真的回到了被注入进程里并生效**；
 *   ③ 静态词表仍然优先 —— 已覆盖的句子**不会**被重复送来问（阴性对照）；
 *   ④ 没把 N2 的排版回填搞坏。
 *
 * 为什么用玩具目标而不是真游戏：这是本项目的既定规矩 ——
 * **每个 hook 上真游戏之前，必须先过玩具目标**。玩具的文本布局、编码、
 * 重绘节奏都是可控的，出问题能定位到具体是哪一环。
 *
 * 为什么断言日志而不是截图：回填发生在**目标进程内部**，外部拿不到 HDC，
 * 让被注入的一侧把事实写进日志、脚本据此做硬断言，是这套验收里最可靠的做法。
 *
 * 构建产物不存在时整组跳过（CI 上没编原生侧也不会红）。
 */

const NATIVE_DIR = resolve(__dirname, '../../../native');
const BUILD = join(NATIVE_DIR, 'build', 'x64');
const INJECTOR = join(BUILD, 'bbInject64.exe');
const TOY = join(BUILD, 'toygame.exe');
const HOOK = join(BUILD, 'toyHook.dll');
const HOOK_LOG = join(BUILD, 'toyHook.log');

const canRun =
  process.platform === 'win32' && existsSync(INJECTOR) && existsSync(TOY) && existsSync(HOOK);

const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';

/** 结束玩具进程（hook 日志被它独占，不结束就读不了）。 */
function killToy(): void {
  try {
    execFileSync(TASKKILL, ['/F', '/IM', 'toygame.exe'], { stdio: 'ignore' });
  } catch {
    // 本来就没在跑
  }
}

/** 测试用的确定性"翻译"：加个前缀，这样"译文是否来自宿主"一眼可验。 */
const MARK = '【中】';
const translator = async (items: { src: string }[]) =>
  items.map((i) => ({ src: i.src, dst: MARK + i.src }));

/** 轮询到条件成立或超时。 */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe.skipIf(!canRun)('运行时注入：宿主驱动 → 取词 → 翻译 → 回填', () => {
  let handle: RuntimeHandle | null = null;

  afterAll(async () => {
    if (handle) await handle.session.close();
    killToy();
  });

  it(
    '整条链路跑通，且译文确实由宿主提供（含阴性对照）',
    async () => {
      killToy();
      if (existsSync(HOOK_LOG)) rmSync(HOOK_LOG); // 从干净日志开始，免得读到上一轮的记录

      // ── 起总线 + 注入启动（注入器会挂起启动、注入、再恢复执行）──
      handle = await startRuntimeSession({
        exe: TOY,
        dll: HOOK,
        nativeDir: NATIVE_DIR,
        translator,
      });
      expect(handle.pid, '注入后应拿到目标进程号').toBeGreaterThan(0);

      // ① 宿主确实被"要过词"，并且给出了译文
      const served = await waitFor(async () => {
        const s = await handle!.session.stats();
        return s.requested > 0 && s.translated > 0;
      }, 15_000);
      expect(served, '宿主没有收到取词请求、或没有应答译文').toBe(true);

      // ② 原生侧确实把译文收下并回填了
      //    （这条走的是"宿主 → 原生"的反向 RPC，顺带把那个方向也验了）
      const nativeApplied = await waitFor(async () => {
        const s = await handle!.session.stats();
        return (s.native?.got ?? 0) > 0 && (s.native?.apply ?? 0) > 0;
      }, 15_000);
      expect(nativeApplied, '原生侧没有收到译文，或收到了却没回填').toBe(true);

      const stats = await handle.session.stats();
      expect(stats.native?.run, '运行时取词应处于启用状态').toBe(1);

      // ── 收尾并读日志 ──
      await handle.session.close();
      handle = null;
      killToy();
      expect(existsSync(HOOK_LOG), `找不到 hook 日志 ${HOOK_LOG}`).toBe(true);
      const log = readFileSync(HOOK_LOG, 'utf8');

      // ③-a 确实出现了运行时取词记录
      const reqLines = log.split(/\r?\n/).filter((l) => l.includes('RUNTIME req='));
      expect(reqLines.length, '日志里没有 RUNTIME req 记录（运行时取词没走到）').toBeGreaterThan(0);

      // ③-b ★ 阴性对照：**只应该问"运行时专线"那一句**。
      //     静态词表已经覆盖的 4 句若也被送来问，说明"先查静态词表"的顺序坏了
      //     —— 那会把宿主白白刷爆，是这条线最容易退化的地方。
      for (const line of reqLines) {
        expect(line, `静态词表已覆盖的句子不该走运行时：${line}`).toContain('ランタイム');
      }

      // ④ ★ 关键断言：回填用的译文里带着**只有宿主才可能给出**的标记
      const applyLine = log
        .split(/\r?\n/)
        .find((l) => l.includes('RUNTIME apply=') && l.includes('この一文は静的な語彙表にありません'));
      expect(applyLine, '没有找到"运行时回填生效"的记录').toBeTruthy();
      expect(applyLine).toContain(MARK);

      // ⑤ 没把 N2 的排版回填搞坏（同一个 DLL 里两套机制要能共存）
      expect(log).toContain('LAYOUT handled=1');
    },
    90_000,
  );
});
