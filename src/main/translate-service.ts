import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { registry } from '@platform/plugin-registry';
import { initPlatform, closePlatform, dbPath } from '@platform/init';
import { restoreAll } from '@platform/patch';
import { runPipeline, type PipelineProgress, type PipelineReport } from '../pipeline/translate-pipeline';
import { createOpenAICompatibleProvider } from '../translate/providers/openai-compatible';
import { getApiKey, getConfig } from '@platform/config';
import { logError, logInfo, logWarn } from '@platform/logbus';
import type {
  TranslationProvider,
  TranslateRequest,
  EngineAdapter,
  RepackResult,
  TextEntry,
} from '@shared/contracts';

/**
 * 汉化编排服务 —— **CLI 与图形界面共用同一套实现**。
 *
 * 为什么要有这一层（而不是让 UI 自己再写一遍）：
 *   1. 编排里有不少"不看代码就会写错"的判断（引擎置信度、数据加密要早退、
 *      进度节流、还原语义……）。两个入口各写一份，迟早会分叉 ——
 *      典型症状是"命令行能跑、点了按钮不对"或反之，而且极难查。
 *   2. CLI 是**已经被真游戏验证过**的那条路（拆 4064/7487 条、字体注入、逐字节还原）。
 *      把它的逻辑原样提出来给 UI 用，等于让 UI 一开始就站在验证过的基础上。
 *   3. 反过来，CLI 也就自动获得了以后在服务层做的任何改进。
 *
 * 分工：
 *   · 本文件 —— 编排与判定（**不碰 UI，也不打印**）
 *   · `cli.ts` —— 把结果格式化到 stdout
 *   · `ipc.ts` —— 把结果与进度送到渲染进程
 */

// ── Provider ───────────────────────────────────────────────────────────────

/**
 * 本地假机翻：不联网、不花钱，用于验证流水线（会原样保留控制符占位）。
 *
 * 保留它是有意的：没配 API Key 时也能把"抽取 → 入库 → 回写 → 字体 → 还原"
 * 整条链路跑通，用来判断"是流程有问题还是翻译有问题"。
 */
export const stubProvider: TranslationProvider = {
  id: 'stub',
  displayName: '本地假机翻（仅供流程验证）',
  offline: true,
  async translate(reqs: TranslateRequest[]) {
    return reqs.map((r) => ({ id: r.id, translated: `【中】${r.source}`, provider: 'stub' }));
  },
};

/**
 * 选 Provider。
 *
 * ★ 两个原则：
 *   ① **不做隐式联网**：只有"界面上配了密钥"或"显式指定 openai"才会走真机翻。
 *      没配就用本地假机翻，并在日志与界面上说明 —— 绝不偷偷把文本发出去。
 *   ② 密钥来源优先级：**界面配置 > 环境变量**。
 *      环境变量优先会让"用户在界面里改了密钥却不生效"变成很难解释的怪现象；
 *      反过来则是可预期的（命令行传的环境变量仍然能用，只是界面配置优先）。
 *
 * ⚠️ 这里**不再用模块级的 `openAIProvider` 单例** —— 那个是在 import 时读环境变量
 *    构造的，界面里改的配置对它无效。改成运行时用配置构造。
 */
export function pickProvider(providerId?: string): { provider: TranslationProvider; autoStub: boolean } {
  const cfg = getConfig();
  const key = getApiKey() || process.env['BAIBAO_OPENAI_API_KEY'] || '';
  const wantOpenAI = providerId === 'openai' || (!providerId && !!key);

  if (wantOpenAI && key) {
    logInfo('provider', `使用 OpenAI 兼容接口：${cfg.openaiBaseUrl} / ${cfg.openaiModel}`);
    return {
      provider: createOpenAICompatibleProvider({
        id: 'openai',
        displayName: 'OpenAI',
        baseUrl: cfg.openaiBaseUrl,
        apiKey: key,
        model: cfg.openaiModel,
        offline: false,
      }),
      autoStub: false,
    };
  }
  if (wantOpenAI && !key) {
    // 明确要求用 openai 却没密钥：说清楚，别静默降级成假机翻
    logWarn('provider', '指定了 openai 但没有可用的 API Key，回退到本地假机翻');
    return { provider: stubProvider, autoStub: true };
  }
  logInfo('provider', '未配置 API Key，使用本地假机翻（只验证流程，不做真翻译）');
  return { provider: stubProvider, autoStub: !providerId };
}

/** 游戏目录 → 稳定的 gameId（同一目录重复汉化会命中同一条记录） */
export function gameIdOf(gameDir: string): string {
  return createHash('sha1').update(resolve(gameDir).toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

// ── 引擎探测 ───────────────────────────────────────────────────────────────

export interface DetectOutcome {
  ok: boolean;
  /** 识别到的引擎 id（未识别时为空） */
  engineId?: string;
  engineName?: string;
  confidence?: number;
  /** 适配器给的说明（含"数据已加密"这类关键告警） */
  notes: string[];
  /** 命中但数据被加密 —— 静态抽取不可用，调用方应**早点告诉用户**而不是跑一半才失败 */
  encrypted: boolean;
  /** 未识别时给出的候选，便于用户判断是不是选错目录了 */
  candidates: string[];
  /** 未识别时的用户可读原因 */
  message?: string;
  gameId: string;
}

export async function detectGame(gameDir: string): Promise<DetectOutcome> {
  const dir = resolve(gameDir);
  const candidates = await registry.detectAll(dir);
  const hit = candidates.find((c) => c.matched);
  const notes = [...(hit?.notes ?? [])];
  if (!hit) {
    logWarn('detect', `没识别出引擎：${dir}（候选：${candidates.map((c) => c.engineId).join(', ') || '无'}）`);
    return {
      ok: false,
      notes,
      encrypted: false,
      candidates: candidates.map((c) => c.engineId),
      message: '没识别出引擎。请确认选的是游戏**根目录**（里面有 data/ 或 www/ 的那一层）。',
      gameId: gameIdOf(dir),
    };
  }
  const adapter: EngineAdapter | undefined = registry.getEngine(hit.engineId);
  const enc = notes.some((n) => n.includes('已加密'));
  logInfo('detect', `识别为 ${adapter?.displayName ?? hit.engineId}（${hit.engineId}）置信度 ${hit.confidence}${enc ? ' ⚠ 数据已加密' : ''}`);
  return {
    ok: true,
    engineId: hit.engineId,
    engineName: adapter?.displayName ?? hit.engineId,
    confidence: typeof hit.confidence === 'number' ? hit.confidence : undefined,
    notes,
    encrypted: notes.some((n) => n.includes('已加密')),
    candidates: candidates.map((c) => c.engineId),
    gameId: gameIdOf(dir),
  };
}

// ── 翻译流水线 ─────────────────────────────────────────────────────────────

export interface TranslateOptions {
  gameDir: string;
  /** 源语言，默认 ja */
  from?: string;
  /** 目标语言，默认 zh-CN */
  to?: string;
  /** 只处理前 N 条（试译） */
  limit?: number;
  /** 是否回写游戏文件（false = 只抽取入库，用来先检查抽得对不对） */
  repack?: boolean;
  /** 是否注入中文字体 */
  injectFont?: boolean;
  /** 'openai' | 'stub'；不给则按环境自动选 */
  providerId?: string;
}

export interface TranslateOutcome {
  report: PipelineReport;
  engineId: string;
  engineName: string;
  providerName: string;
  gameId: string;
  dbPath: string;
  /** 是否是"没配密钥所以用了假机翻"（调用方要提示用户，否则会以为翻译坏了） */
  autoStub: boolean;
  durationMs: number;
}

/**
 * 跑一次完整的汉化。
 *
 * @param onProgress 进度回调。UI 靠它更新进度条；CLI 靠它刷新一行。
 * @throws 未识别出引擎 / 引擎数据被加密时抛错（这两种情况应在调用方**提前**拦下，
 *         这里再拦一次是为了"即使有人直接调也安全"）
 */
export async function runTranslate(
  opts: TranslateOptions,
  onProgress?: (p: PipelineProgress) => void,
): Promise<TranslateOutcome> {
  const t0 = Date.now();
  const gameDir = resolve(opts.gameDir);
  const det = await detectGame(gameDir);
  if (!det.ok || !det.engineId) throw new Error(det.message ?? '没识别出引擎');
  if (det.encrypted) {
    throw new Error('该游戏的数据文件被加密，静态抽取不可用（需运行时提取）。已中止。');
  }
  const adapter = registry.getEngine(det.engineId);
  if (!adapter) throw new Error(`引擎 ${det.engineId} 已识别但没有可用的适配器`);

  logInfo('pipeline', `开始汉化：${gameDir}（${det.engineName}，${opts.from ?? 'ja'} → ${opts.to ?? 'zh-CN'}${opts.limit ? `，试译 ${opts.limit} 条` : ''}）`);
  const { provider, autoStub } = pickProvider(opts.providerId);
  const store = initPlatform();
  try {
    const report = await runPipeline({
      gameDir,
      gameId: det.gameId,
      adapter,
      provider,
      store,
      from: opts.from ?? 'ja',
      to: opts.to ?? 'zh-CN',
      limit: opts.limit,
      repack: opts.repack ?? true,
      injectFont: opts.injectFont ?? false,
      onProgress,
    });
    logInfo('pipeline',
      `汉化完成：抽取 ${report.extracted}，入库 ${report.upsert.inserted}，翻译成功 ${report.translated}，` +
      `冲突 ${report.conflicts}，失败 ${report.failed}` +
      (report.repack ? `，回写 ${report.repack.written}` : '') +
      `（${Date.now() - t0}ms）`);
    if (report.errors.length) logError('pipeline', `有 ${report.errors.length} 条错误：${report.errors[0]}`);
    return {
      report,
      engineId: det.engineId,
      engineName: det.engineName ?? det.engineId,
      providerName: provider.displayName,
      gameId: det.gameId,
      dbPath: dbPath(),
      autoStub,
      durationMs: Date.now() - t0,
    };
  } finally {
    closePlatform();
  }
}

// ── 还原 ───────────────────────────────────────────────────────────────────

export interface RestoreOutcome {
  /** 展开的补丁数 */
  patches: number;
  /** 还原的文件数 */
  restored: number;
  errors: string[];
  /** 什么改动都没有 */
  nothingToDo: boolean;
}

/**
 * 一键还原（工程红线：**改前先备份、必须可逆**）。
 *
 * 语义：把我们对这个游戏做的所有改动（回写 + 字体）**按补丁倒序**展开回去，
 * 回到翻译前的状态。这是"可逆"这条红线的兑现点，所以要能被 UI 直接调到。
 */
export async function restoreGame(gameDir: string): Promise<RestoreOutcome> {
  const r = await restoreAll(resolve(gameDir));
  logInfo('restore', r.patches === 0
    ? `还原：没有需要还原的改动（${gameDir}）`
    : `还原完成：展开 ${r.patches} 个补丁，还原 ${r.restored} 个文件${r.errors.length ? `（${r.errors.length} 个错误）` : ''}`);
  return {
    patches: r.patches,
    restored: r.restored,
    errors: r.errors,
    nothingToDo: r.patches === 0,
  };
}

// ── 只回写（把工作台里改好的译文落到游戏文件）───────────────────────────────

/**
 * 为什么需要"只回写"这个单独入口 —— 这是**闭环的缺口**。
 *
 * 在此之前，用户在人工修订工作台里改完译文，只能落在文本库里；
 * 要让它进游戏，唯一的路是**重跑整条流水线**（重新抽取 + 查 TM + 可能再次机翻）。
 * 这既慢又蠢：译文一条都没变，却要把整条链路走一遍，还可能覆盖用户的手改。
 *
 * 所以补一个"只回写"：从库里取出 translated / reviewed 的条目，直接调
 * `adapter.repack` —— 复用引擎适配器里那套**已经带自动备份**的回写实现，
 * 不另写一套。
 *
 * ★ 只写 translated / reviewed，**绝不写 pending / conflict**：
 *   这与流水线的语义一致。冲突条目的控制符占位有问题，写进去就是**破坏游戏文本**，
 *   所以宁可漏写也不能写错。
 */

export interface RepackPreview {
  gameId: string;
  engineId: string;
  engineName: string;
  /** 引擎是否支持静态回写（有些引擎只有运行时改造） */
  supported: boolean;
  reason?: string;
  /** 引擎能力里"repack"这一项 */
  counts: { translated: number; reviewed: number; pending: number; conflict: number };
  /** 本次**将要**写回的条数（= translated + reviewed） */
  willWrite: number;
  /** 抽查前若干条：让用户看清"要写的就是我改的那些"，而不是只给个数字 */
  samples: Array<{ path: string; key: string; source: string; translated: string }>;
}

/** 回写前的预览：先看清要写什么，再决定写不写。 */
export async function previewRepack(gameDir: string): Promise<RepackPreview> {
  const dir = resolve(gameDir);
  const det = await detectGame(dir);
  if (!det.ok || !det.engineId) throw new Error(det.message ?? '没识别出引擎');
  const adapter = registry.getEngine(det.engineId);
  if (!adapter) throw new Error(`引擎 ${det.engineId} 已识别但没有可用的适配器`);

  const store = initPlatform();
  try {
    const stats = store.stats(det.gameId);
    const ready = [
      ...store.list(det.gameId, { status: 'translated', limit: 1_000_000 }),
      ...store.list(det.gameId, { status: 'reviewed', limit: 1_000_000 }),
    ];
    return {
      gameId: det.gameId,
      engineId: det.engineId,
      engineName: det.engineName ?? det.engineId,
      supported: adapter.capabilities?.repack !== false,
      reason: adapter.capabilities?.repack === false
        ? '这个引擎的适配器没有实现静态回写（可能只支持运行时改造）'
        : undefined,
      counts: {
        translated: stats.byStatus.translated ?? 0,
        reviewed: stats.byStatus.reviewed ?? 0,
        pending: stats.byStatus.pending ?? 0,
        conflict: stats.byStatus.conflict ?? 0,
      },
      willWrite: ready.length,
      samples: ready.slice(0, 8).map((e: TextEntry) => ({
        path: e.path, key: e.key,
        source: e.source.length > 120 ? e.source.slice(0, 120) + '…' : e.source,
        translated: (e.translated ?? '').length > 120 ? (e.translated ?? '').slice(0, 120) + '…' : (e.translated ?? ''),
      })),
    };
  } finally {
    closePlatform();
  }
}

export interface RepackOnlyOutcome {
  repack: RepackResult;
  engineId: string;
  engineName: string;
  gameId: string;
  durationMs: number;
}

/**
 * 只回写（不做抽取、不做翻译）。
 *
 * 回写前**自动备份**由适配器的 repack 实现负责（`RepackResult.backupDir`），
 * 这是工程红线"改前先备份、必须可逆"的兑现点，所以界面上要把备份目录显示出来，
 * 并给"一键还原"的入口。
 */
export async function repackGame(
  gameDir: string,
  onProgress?: (p: PipelineProgress) => void,
): Promise<RepackOnlyOutcome> {
  const t0 = Date.now();
  const dir = resolve(gameDir);
  const det = await detectGame(dir);
  if (!det.ok || !det.engineId) throw new Error(det.message ?? '没识别出引擎');
  if (det.encrypted) {
    throw new Error('该游戏的数据文件被加密，静态回写不可用。已中止。');
  }
  const adapter = registry.getEngine(det.engineId);
  if (!adapter) throw new Error(`引擎 ${det.engineId} 已识别但没有可用的适配器`);

  const store = initPlatform();
  try {
    const ready = [
      ...store.list(det.gameId, { status: 'translated', limit: 1_000_000 }),
      ...store.list(det.gameId, { status: 'reviewed', limit: 1_000_000 }),
    ];
    onProgress?.({ phase: 'repack', current: 0, total: ready.length, message: '正在回写…' });
    logInfo('repack', `只回写：准备写入 ${ready.length} 条（${det.engineName}）`);
    const repack = await adapter.repack(dir, ready);
    logInfo('repack', `回写完成：写入 ${repack.written}，无需改动 ${repack.unchanged}，跳过 ${repack.skipped}` +
      (repack.backupDir ? `，备份 ${repack.backupDir}` : ''));
    onProgress?.({ phase: 'repack', current: repack.written, total: ready.length });
    onProgress?.({ phase: 'done', current: 1, total: 1 });
    return {
      repack,
      engineId: det.engineId,
      engineName: det.engineName ?? det.engineId,
      gameId: det.gameId,
      durationMs: Date.now() - t0,
    };
  } finally {
    closePlatform();
  }
}

export { dbPath };
