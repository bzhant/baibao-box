import type {
  EngineAdapter,
  RepackResult,
  FontInjectOutcome,
  EntryStatus,
  TextEntry,
  TranslateRequest,
  TranslationProvider,
} from '@shared/contracts';
import type { TextStore, UpsertResult } from '@platform/store/text-store';
import {
  mask,
  unmask,
  missingPlaceholders,
  defaultPlaceholder,
} from '../text-kernel/control-codes';
import { patternFor } from '../text-kernel/patterns';
import {
  normalizeGlossary,
  maskGlossary,
  unmaskGlossary,
  missingGlossaryTerms,
  type Glossary,
} from '../translate/glossary';
import { TranslationMemory } from '../translate/tm';
import { checkQuality, hasHardIssue, summarizeSoft, type LengthPair } from '../translate/quality';
import { RateLimiter, type RateLimitOptions } from '../translate/rate-limiter';

/**
 * 汉化流水线（骨架 → 内核）：
 *
 *   抽取 → 入库 → 取待译 → **TM 命中直接用** → 掩码(控制符+术语) → 机翻 → 质检 → 还原
 *        → 入库 → 回写 → 字体注入
 *
 * 关键设计（每条都是踩过坑换来的）：
 *
 * 1. **以文本库为事实来源**。取 `status='pending'` 而非"这次抽出来的列表"，
 *    于是原文没变的旧译文会被保留、断点续翻天然成立、重跑不重复花钱。
 *
 * 2. **翻译记忆（TM）**：原文精确匹配就复用已有译文，**不送机翻**。本游戏优先，其次跨游戏。
 *
 * 3. **术语强制一致**：术语在送机翻前掩码成 `__GTn__`，翻完强制替换成指定译法，
 *    人名/地名不会一批一个译法。**不做"翻完再替换"**（那不可靠）。
 *
 * 4. **控制符先掩码**（`__BBn__`），翻完校验占位符；**坏了一律标 conflict、绝不写回游戏**。
 *
 * 5. **质检**：硬问题（占位符丢失/空译文）→ 拒绝写回；软问题（长度比离谱、
 *    一字未译、退化重复、空白丢失、术语缺失）→ 照写但记警告。
 *
 * 6. **并发限流**：机翻接口有配额，用 RateLimiter 控并发与最小间隔。
 *
 * 7. **反向 TM 防护**：静态回写会把译文写进游戏，于是"再抽一次"读到的其实是
 *    **我们自己的输出**；不过滤就会二次翻译成 `【译】【译】…`。用 `translatedSet` 过滤。
 */

export type PipelinePhase = 'extract' | 'store' | 'tm' | 'translate' | 'repack' | 'font' | 'done';

export interface PipelineProgress {
  phase: PipelinePhase;
  current: number;
  total: number;
  message?: string;
}

export interface PipelineOptions {
  gameDir: string;
  /** 文本库里区分游戏的主键（建议用目录路径的 hash） */
  gameId: string;
  adapter: EngineAdapter;
  provider: TranslationProvider;
  store: TextStore;
  from: string;
  to: string;
  /** 每批送多少条给 Provider（太少浪费往返、太多容易被服务端截断） */
  batchSize?: number;
  /** 机翻并发与最小间隔（限流） */
  rateLimit?: RateLimitOptions;
  /** 只处理前 N 条（冒烟/试译用）。不传 = 全部 */
  limit?: number;
  /** 是否回写（默认 true） */
  repack?: boolean;
  /** 是否注入中文字体（默认 false） */
  injectFont?: boolean;
  /** 术语表：原文 -> 强制译文 */
  glossary?: Glossary;
  /** 是否使用翻译记忆（默认 true） */
  useTM?: boolean;
  /** 长度比质检的语种对，默认 cjk-cjk */
  lengthPair?: LengthPair;
  onProgress?: (p: PipelineProgress) => void;
}

export interface PipelineReport {
  engine: string;
  /** 从游戏里抽到的条目数 */
  extracted: number;
  /** 抽到的文本里已经是我们自己写回去的译文、被跳过的条数（反向 TM 防护） */
  alreadyApplied: number;
  upsert: UpsertResult;
  /** 库里待译的总数（含 TM 命中） */
  candidates: number;
  /** TM 命中、直接复用译文、没送机翻的条数 */
  fromCache: number;
  /** 实际送给 Provider 的条数 */
  sentToProvider: number;
  /** 实际调用 Provider 的次数（批次） */
  providerCalls: number;
  translated: number;
  /** 硬质检失败（占位符丢失/空），标 conflict 且未写回 */
  conflicts: number;
  /** Provider 报错或漏返回的条数 */
  failed: number;
  /** 软质检警告统计（code -> 次数） */
  qualityWarnings: Record<string, number>;
  repack?: RepackResult;
  font?: FontInjectOutcome;
  errors: string[];
  durationMs: number;
}

/** 上下文提示：带上一条原句，帮 Provider 判断语气/人称 */
function contextHint(entries: readonly TextEntry[], idx: number): string | undefined {
  const own = entries[idx]?.context;
  const prev = idx > 0 ? entries[idx - 1]?.source : undefined;
  const bits: string[] = [];
  if (own) bits.push(own);
  if (prev) bits.push(`上一句：${prev}`);
  return bits.length ? bits.join('；') : undefined;
}

export async function runPipeline(opts: PipelineOptions): Promise<PipelineReport> {
  const t0 = Date.now();
  const batchSize = opts.batchSize ?? 20;
  const errors: string[] = [];
  const report: PipelineReport = {
    engine: opts.adapter.id,
    extracted: 0,
    alreadyApplied: 0,
    upsert: { inserted: 0, refreshed: 0, invalidated: 0 },
    candidates: 0,
    fromCache: 0,
    sentToProvider: 0,
    providerCalls: 0,
    translated: 0,
    conflicts: 0,
    failed: 0,
    qualityWarnings: {},
    errors,
    durationMs: 0,
  };

  // ── 1. 抽取 ────────────────────────────────────────────────
  const extracted: TextEntry[] = [];
  for await (const e of opts.adapter.extract(opts.gameDir)) {
    extracted.push(e);
    if (opts.limit && extracted.length >= opts.limit) break;
  }
  report.extracted = extracted.length;
  opts.onProgress?.({ phase: 'extract', current: extracted.length, total: extracted.length });

  // ── 1.5 反向 TM 防护 ───────────────────────────────────────
  const knownTranslations = opts.store.translatedSet(opts.gameId);
  const fresh = knownTranslations.size
    ? extracted.filter((e) => !knownTranslations.has(e.source))
    : extracted;
  report.alreadyApplied = extracted.length - fresh.length;

  // ── 2. 入库（幂等；原文变更会自动打回 pending）─────────────
  report.upsert = opts.store.upsert(opts.gameId, fresh, { session: new Date().toISOString() });
  opts.onProgress?.({ phase: 'store', current: report.upsert.inserted, total: fresh.length });

  // ── 3. 取待译（以库为事实来源 → 断点续翻 / 不重复花钱）─────
  const pending = opts.store.list(opts.gameId, { status: 'pending', limit: opts.limit ?? 1_000_000 });
  report.candidates = pending.length;

  // ── 3.5 翻译记忆（TM）：命中的直接复用，不送机翻 ───────────
  let toTranslate = pending;
  if (opts.useTM !== false && pending.length > 0) {
    const tm = new TranslationMemory(opts.store);
    const { hits } = tm.partition(opts.gameId, pending.map((e) => e.source));
    const cached = pending
      .filter((e) => hits.has(e.source))
      .map((e) => ({
        path: e.path,
        key: e.key,
        translated: hits.get(e.source)!.translated,
        status: 'translated' as EntryStatus,
      }));
    if (cached.length > 0) opts.store.setTranslations(opts.gameId, cached);
    report.fromCache = cached.length;
    toTranslate = pending.filter((e) => !hits.has(e.source));
    opts.onProgress?.({ phase: 'tm', current: cached.length, total: pending.length });
  }
  report.sentToProvider = toTranslate.length;

  // ── 4. 分批 + 掩码 + 机翻（并发限流）──────────────────────
  const pattern = patternFor(opts.adapter.id);
  const glossary = normalizeGlossary(opts.glossary);
  const limiter = new RateLimiter(opts.rateLimit ?? {});

  const chunks: Array<{ start: number; entries: TextEntry[] }> = [];
  for (let i = 0; i < toTranslate.length; i += batchSize) {
    chunks.push({ start: i, entries: toTranslate.slice(i, i + batchSize) });
  }

  let batchesDone = 0;
  const tasks = chunks.map(({ start, entries }) => async () => {
    // 掩码：先控制符（__BBn__），再术语（__GTn__）
    const cms = entries.map((e) => mask(e.source, pattern));
    const gms = cms.map((cm) => maskGlossary(cm.masked, glossary));

    const reqs: TranslateRequest[] = entries.map((_, k) => ({
      id: String(start + k),
      source: gms[k].masked,
      from: opts.from,
      to: opts.to,
      context: contextHint(toTranslate, start + k),
    }));

    report.providerCalls++;
    let results;
    try {
      results = await opts.provider.translate(reqs);
    } catch (err) {
      report.failed += entries.length;
      errors.push(`批次 @${start} 翻译失败: ${(err as Error).message}`);
      return;
    }
    const byId = new Map(results.map((r) => [r.id, r.translated]));

    const updates: Array<{ path: string; key: string; translated: string | null; status?: EntryStatus }> = [];

    for (let k = 0; k < entries.length; k++) {
      const e = entries[k];
      const raw = byId.get(String(start + k));
      if (typeof raw !== 'string' || raw === '') {
        report.failed++;
        continue;
      }

      // 还原顺序：术语占位符 → 强制译法；再控制符占位符 → 控制码（两者互不干扰）
      const afterGlossary = unmaskGlossary(raw, gms[k].map);

      // 硬质检：控制符占位符一个都不能丢
      const lost = missingPlaceholders(afterGlossary, cms[k].tokens.length, defaultPlaceholder);
      if (lost.length > 0) {
        report.conflicts++;
        // 保留机翻原文（含占位符）供人工修，但**不写回游戏**
        updates.push({ path: e.path, key: e.key, translated: raw, status: 'conflict' });
        continue;
      }

      const restored = unmask(afterGlossary, cms[k].tokens, defaultPlaceholder);

      // 软质检（照写，但记警告）
      const issues = checkQuality(e.source, restored, {
        expectPlaceholders: 0, // 硬检查上面已单独做
        lengthPair: opts.lengthPair ?? 'cjk-cjk',
        glossaryMissing: missingGlossaryTerms(e.source, restored, glossary),
      });
      if (hasHardIssue(issues)) {
        // 空译文等硬问题同样拒绝写回
        report.conflicts++;
        updates.push({ path: e.path, key: e.key, translated: raw, status: 'conflict' });
        for (const h of issues.filter((i) => i.level === 'hard')) {
          errors.push(`${e.path} 质检硬失败[${h.code}]: ${h.message}`);
        }
        continue;
      }
      for (const [code, n] of Object.entries(summarizeSoft(issues))) {
        report.qualityWarnings[code] = (report.qualityWarnings[code] ?? 0) + n;
      }

      report.translated++;
      updates.push({ path: e.path, key: e.key, translated: restored, status: 'translated' });
    }

    if (updates.length > 0) opts.store.setTranslations(opts.gameId, updates);
    batchesDone++;
    opts.onProgress?.({
      phase: 'translate',
      current: Math.min(batchesDone * batchSize, toTranslate.length),
      total: toTranslate.length,
    });
  });

  await limiter.runAll(tasks);

  // ── 5. 回写（只写 translated / reviewed）───────────────────
  if (opts.repack !== false) {
    const ready = [
      ...opts.store.list(opts.gameId, { status: 'translated', limit: 1_000_000 }),
      ...opts.store.list(opts.gameId, { status: 'reviewed', limit: 1_000_000 }),
    ];
    report.repack = await opts.adapter.repack(opts.gameDir, ready);
    if (report.repack.errors.length) errors.push(...report.repack.errors);
    opts.onProgress?.({ phase: 'repack', current: report.repack.written, total: ready.length });
  }

  // ── 6. 字体注入（引擎可选能力）─────────────────────────────
  if (opts.injectFont && opts.adapter.injectCjkFont) {
    try {
      // 拿**真实译文**当样本做字形覆盖校验：确认这台机器上真能显示出来，
      // 而不是配好了字体名结果渲染成豆腐块（"能看"的保证）。
      const sample = [
        ...opts.store.list(opts.gameId, { status: 'translated', limit: 40_000 }),
        ...opts.store.list(opts.gameId, { status: 'reviewed', limit: 40_000 }),
      ]
        .map((e) => e.translated ?? '')
        .join('')
        .slice(0, 200_000);
      report.font = await opts.adapter.injectCjkFont(opts.gameDir, {
        sampleText: sample || undefined,
      });
      opts.onProgress?.({ phase: 'font', current: 1, total: 1, message: report.font.detail });
      if (report.font.coverage && !report.font.coverage.ok) {
        report.qualityWarnings['font-missing-glyphs'] = report.font.coverage.missing.length;
      }
    } catch (err) {
      errors.push(`字体注入失败: ${(err as Error).message}`);
    }
  }

  report.durationMs = Date.now() - t0;
  opts.onProgress?.({ phase: 'done', current: 1, total: 1 });
  return report;
}
