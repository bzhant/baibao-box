import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logError, logInfo, logWarn } from '@platform/logbus';
import type { TranslationProvider } from '@shared/contracts';
import {
  acquireGameLock,
  cachePathFor,
  createMvmzActivator,
  createProviderTranslator,
  detectMvmzLayout,
  resolveBridgePath,
  startRuntimeSessionWith,
  translatorStats,
  TranslationStore,
  uninstallMvmzBridge,
  type GameLock,
  type MvmzActivator,
  type RuntimeHandle,
  type RuntimeTranslator,
} from '../host/runtime';

/**
 * **运行时汉化**的编排（一键汉化）。
 *
 * 与静态改文件的分工：
 *   静态 —— 抽取 → 翻译 → 回写游戏数据文件。持久、离线可玩，但改游戏文件，
 *           且对"数据被加密/文本在运行时才算出来"的游戏无效。
 *   运行时 —— 启动游戏时把桥装进去，宿主边玩边翻。**不改游戏数据文件**，
 *           对加密游戏同样有效，退出时逐字节还原（哈希校验）。
 *
 * ★ 为什么抽成独立服务、而不是写在 CLI 或 IPC 里：
 *   项目铁律是"命令行与图形界面**共用同一套编排**"。
 *   两处各写一份，迟早分叉，而分叉的症状是"命令行能跑、点按钮不对"（或反之），极难查。
 *   所以这里只做编排，CLI 与界面都调它。
 *
 * ★ 翻译走**已有的 Provider 体系**（界面里配的 API 密钥、模型、baseUrl 都用得上），
 *   前面再叠一层**译文库**（本地缓存 + 游戏目录里已有的外部字典）：
 *   已翻过的句子零延迟零费用，第二次启动就是瞬时的。
 */

export interface RuntimeStartOptions {
  gameDir: string;
  /**
   * **翻译能力由调用方注入**（命令行/界面各自从配置里解析，测试可注入确定性实现）。
   *
   * 为什么不在这里自己解析：那会把这个服务与"Electron 配置/密钥"绑死，
   * 既不能在纯 Node 里测（`app.getPath` 不存在），也违背了"编排不该关心能力从哪来"。
   */
  provider: TranslationProvider;
  /** 展示用名字（界面/日志里显示用了哪个接口） */
  providerName: string;
  /** 是不是降级成了"本地假机翻"（调用方告知，用于给用户提示） */
  autoStub?: boolean;
}

export interface RuntimeStatusSnapshot {
  running: boolean;
  gameDir?: string;
  engine?: string;
  providerName?: string;
  bridgeLog?: string;
  /** 译文库条数 */
  storeSize?: number;
  /** 宿主侧账本 */
  requested?: number;
  batches?: number;
  translated?: number;
  /** 引擎侧统计（可能需要它在线） */
  native?: Record<string, number> | null;
  /** 命中的本地译文条数 / 调用接口次数 / 送出条数 / 得到译文条数 */
  localHits?: number;
  apiCalls?: number;
  apiSent?: number;
  apiGot?: number;
}

export class RuntimeError extends Error {}

let current: {
  handle: RuntimeHandle;
  activator: MvmzActivator;
  store: TranslationStore;
  translator: RuntimeTranslator;
  gameDir: string;
  engine: string;
  providerName: string;
  bridgeLog: string;
  stopping: boolean;
  /** 游戏目录锁（跨进程）：防止界面与命令行同时对同一个游戏动手 */
  lock: GameLock;
} | null = null;

/** 「收尾完成」的信号（CLI 等它；界面不用等，靠轮询 status）。 */
let stopResolve: (() => void) | null = null;
let stopped: Promise<void> = Promise.resolve();
/** 最近一次收尾后的统计（收尾时 current 已清空，所以单独存一份给界面/命令行看结果）。 */
let lastSummary: RuntimeStatusSnapshot | null = null;

export function whenRuntimeStopped(): Promise<void> {
  return stopped;
}

export function lastRuntimeSummary(): RuntimeStatusSnapshot | null {
  return lastSummary;
}

/** 当前运行时会话的状态（界面用它渲染"正在汉化…"）。 */
export function runtimeStatus(): RuntimeStatusSnapshot {
  if (!current) return { running: false };
  const st = current.handle.session.stats();
  const ts = translatorStats(current.translator);
  return {
    running: true,
    gameDir: current.gameDir,
    engine: current.engine,
    providerName: current.providerName,
    bridgeLog: current.bridgeLog,
    storeSize: current.store.size,
    requested: st.requested,
    batches: st.batches,
    translated: st.translated,
    localHits: ts?.localHits ?? 0,
    apiCalls: ts?.calls ?? 0,
    apiSent: ts?.sent ?? 0,
    apiGot: ts?.got ?? 0,
  };
}

export interface RuntimeStartResult {
  gameDir: string;
  engine: string;
  providerName: string;
  /** 是否降级成了本地假机翻（没配密钥时会这样） */
  autoStub: boolean;
  bridgeLog: string;
  storeSize: number;
  seeded: number;
}

/**
 * 一键汉化：装桥 → 起游戏 → 开始边玩边翻。**返回时游戏已经在跑，并且已经是中文。**
 *
 * 收尾有两条路：用户关掉游戏（自动收尾）或调用 `stopRuntime()`（强杀 + 还原）。
 */
export async function startRuntime(o: RuntimeStartOptions): Promise<RuntimeStartResult> {
  if (current) {
    throw new RuntimeError(`已经有一个运行时汉化在进行中：${current.gameDir}`);
  }
  const gameDir = o.gameDir;

  // ★ 先用**跨进程锁**把游戏目录占住，再动它的文件。
  //   默认不等待（用户又点一次按钮应当立刻被告知"已经在汉化中"）；
  //   自动化测试用 BB_GAME_LOCK_TIMEOUT_MS 把彼此串起来。
  const lockTimeout = Number(process.env['BB_GAME_LOCK_TIMEOUT_MS'] ?? 0) || 0;
  const lock = acquireGameLock(gameDir, { timeoutMs: lockTimeout });

  const layout = detectMvmzLayout(gameDir);
  if (!layout) {
    lock.release();
    throw new RuntimeError(
      '运行时汉化目前支持 RPG Maker MV / MZ（找不到 js/rpg_core.js 或 js/rmmz_core.js）。\n' +
        '其它引擎请用静态汉化（抽取 → 翻译 → 回写）。',
    );
  }

  const bridgePath = resolveBridgePath();
  if (!bridgePath) {
    lock.release();
    throw new RuntimeError('找不到运行时桥插件（BB_RuntimeBridge.js）—— 安装包不完整？');
  }

  // ① 译文库：本地缓存 + 游戏目录里已有的外部字典（有就直接用，瞬时且免费）
  const store = new TranslationStore(cachePathFor(gameDir));
  const seeded = store.load(gameDir);

  // ② 翻译接口由调用方给（界面里配的 API / 命令行指定 / 测试注入的确定性实现）
  const provider = o.provider;
  if (o.autoStub) {
    logWarn('runtime', '没有可用的翻译接口密钥 —— 用本地假机翻（译文形如【中】原文），只用于跑通流程');
  }

  const translator = createProviderTranslator({ provider, store, to: 'zh-CN' });
  const bridgeLog = join(tmpdir(), `bb-bridge-${Date.now()}.log`);
  const activator = createMvmzActivator({ gameDir, bridgePath, bridgeLogPath: bridgeLog });

  logInfo('runtime', `一键汉化开始：${layout.engine} · ${o.providerName} · ${gameDir}`);

  let handle: RuntimeHandle;
  try {
    handle = await startRuntimeSessionWith({
      translator,
      activator,
      stateDir: tmpdir(),
      // 真实游戏启动到就绪可能 40 秒以上（见 tools/mv-runtime/README 坑 2）
      clientTimeoutMs: 180_000,
    });
  } catch (e) {
    // 起不来也要把现场收干净（插件可能已经装进去了）
    await activator.deactivate().catch(() => undefined);
    store.flush();
    lock.release();
    throw e;
  }

  current = {
    handle,
    activator,
    store,
    translator,
    gameDir,
    engine: layout.engine,
    providerName: o.providerName,
    bridgeLog,
    stopping: false,
    lock,
  };
  stopped = new Promise<void>((res) => {
    stopResolve = res;
  });

  // 用户关掉游戏 → 自动收尾（还原游戏文件）
  void activator.whenExited().then(() => {
    void stopRuntime().catch((e) => logError('runtime', `自动收尾失败：${(e as Error).message}`));
  });

  return {
    gameDir,
    engine: layout.engine,
    providerName: o.providerName,
    autoStub: o.autoStub ?? false,
    bridgeLog,
    storeSize: store.size,
    seeded: seeded.seeded,
  };
}

/** 收尾：结束游戏进程 + **逐字节还原**游戏文件 + 保存译文库。 */
export async function stopRuntime(): Promise<void> {
  const c = current;
  if (!c || c.stopping) return;
  c.stopping = true;
  current = null;

  // 先把统计快照留下来 —— current 一清空，界面/命令行就看不到过程数据了
  const st = c.handle.session.stats();
  const ts = translatorStats(c.translator);
  lastSummary = {
    running: false,
    gameDir: c.gameDir,
    engine: c.engine,
    providerName: c.providerName,
    bridgeLog: c.bridgeLog,
    storeSize: c.store.size,
    requested: st.requested,
    batches: st.batches,
    translated: st.translated,
    localHits: ts?.localHits ?? 0,
    apiCalls: ts?.calls ?? 0,
    apiSent: ts?.sent ?? 0,
    apiGot: ts?.got ?? 0,
  };

  try {
    c.store.flush();
  } catch (e) {
    logWarn('runtime', `译文库保存失败：${(e as Error).message}`);
  }
  try {
    await c.activator.deactivate(); // 内部会结束游戏进程，然后按哈希校验还原
  } catch (e) {
    logError('runtime', `还原游戏文件失败：${(e as Error).message}`);
  }
  try {
    await c.handle.session.close();
  } catch {
    /* 尽力而为 */
  }
  logInfo('runtime', '一键汉化已收尾：游戏文件已还原');

  try {
    c.lock.release();
  } catch {
    /* 尽力而为 */
  }

  stopResolve?.();
  stopResolve = null;
}

/** 万一进程被强杀，用这个把游戏目录收干净（界面/命令行都能调）。 */
export function cleanupGameDir(gameDir: string): { restored: boolean; how: string } {
  return uninstallMvmzBridge(gameDir);
}

export function isRuntimeActive(): boolean {
  return current !== null;
}
