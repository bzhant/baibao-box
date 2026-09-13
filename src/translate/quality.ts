/**
 * 译文质量自检。
 *
 * 机翻常会出这些毛病，得机器自动拦下来：
 *
 *   hard（**拒绝写回**，标 conflict）：
 *     - 控制符占位符被弄丢/弄坏（游戏会崩）
 *     - 译文为空
 *   soft（**仍可写回**，但要记警告供人工复查）：
 *     - 长度比离谱（日文→中文一般接近 1:1，3 倍以上或 1/4 以下都可疑）
 *     - 译文与原文一字不差（很可能根本没译）
 *     - 退化成同一字符的重复（"啊啊啊啊啊啊"——机翻抽风）
 *     - 首尾空白/换行被吞（会破坏排版）
 *     - 术语缺失（原文有术语但译文没出现强制译法）
 */

export type IssueLevel = 'hard' | 'soft';

export interface QualityIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

export type LengthPair = 'cjk-cjk' | 'cjk-latin' | 'any';

export interface QualityOptions {
  /** 期望保留的控制符占位符数量（来自 mask 的 token 数） */
  expectPlaceholders?: number;
  placeholderFn?: (i: number) => string;
  /** 长度比检查的语种对；默认 'cjk-cjk' */
  lengthPair?: LengthPair;
  /** 术语缺失清单（外部算好传入），一个术语一条警告 */
  glossaryMissing?: string[];
}

const DEFAULT_PLACEHOLDER_FN = (i: number) => `__BB${i}__`;

/** 计算长度比（译文 / 原文），忽略首尾空白 */
function lengthRatio(source: string, translated: string): number {
  const a = source.trim().length;
  const b = translated.trim().length;
  if (a === 0) return 1;
  return b / a;
}

const RATIO_RANGES: Record<Exclude<LengthPair, 'any'>, { min: number; max: number }> = {
  'cjk-cjk': { min: 0.25, max: 3.0 },
  'cjk-latin': { min: 0.15, max: 4.0 },
};

/** 是否含字母/表意文字（用于"没译"判断） */
function hasLetters(s: string): boolean {
  return /[\p{L}\p{Lo}]/u.test(s);
}

/** 检出退化的长重复（同一字符连续 > threshold 次） */
function hasDegenerateRepeat(s: string, threshold = 10): boolean {
  const m = s.match(/(.)\1{9,}/);
  return m !== null && threshold <= (m[0]?.length ?? 0);
}

export function checkQuality(
  source: string,
  translated: string,
  opts: QualityOptions = {},
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const src = source ?? '';
  const tgt = translated ?? '';
  const phFn = opts.placeholderFn ?? DEFAULT_PLACEHOLDER_FN;

  // ── hard ───────────────────────────────────────────────────
  if (tgt.trim() === '') {
    issues.push({ level: 'hard', code: 'empty', message: '译文为空' });
    return issues; // 空译文就不用查别的了
  }

  // 控制符占位符必须一个不丢
  const expect = opts.expectPlaceholders ?? 0;
  if (expect > 0) {
    const missing: number[] = [];
    for (let i = 0; i < expect; i++) {
      if (!tgt.includes(phFn(i))) missing.push(i);
    }
    if (missing.length > 0) {
      issues.push({
        level: 'hard',
        code: 'placeholder-missing',
        message: `控制符占位符缺失 ${missing.length}/${expect}（索引 ${missing.slice(0, 5).join(',')}${missing.length > 5 ? '…' : ''}）`,
      });
    }
  }

  // ── soft ───────────────────────────────────────────────────
  // 长度比离谱
  const pair = opts.lengthPair ?? 'cjk-cjk';
  if (pair !== 'any') {
    const ratio = lengthRatio(src, tgt);
    const range = RATIO_RANGES[pair];
    if (ratio < range.min || ratio > range.max) {
      issues.push({
        level: 'soft',
        code: 'length-ratio',
        message: `长度比 ${ratio.toFixed(2)} 超出 ${range.min}~${range.max} 的可疑范围`,
      });
    }
  }

  // 一字不差（很可能根本没译）
  if (src.trim() === tgt.trim() && hasLetters(src)) {
    issues.push({ level: 'soft', code: 'unchanged', message: '译文与原文一字不差，很可能没翻译' });
  }

  // 退化成重复串
  if (hasDegenerateRepeat(tgt)) {
    issues.push({ level: 'soft', code: 'repetition', message: '译文出现超长重复字符（机翻退化）' });
  }

  // 首尾空白/换行被吞
  const srcLead = /^\s+/.exec(src)?.[0].length ?? 0;
  const srcTrail = /\s+$/.exec(src)?.[0].length ?? 0;
  const tgtLead = /^\s+/.exec(tgt)?.[0].length ?? 0;
  const tgtTrail = /\s+$/.exec(tgt)?.[0].length ?? 0;
  if (srcLead !== tgtLead || srcTrail !== tgtTrail) {
    issues.push({
      level: 'soft',
      code: 'whitespace',
      message: `首尾空白不一致（原 前${srcLead}/后${srcTrail} vs 译 前${tgtLead}/后${tgtTrail}）`,
    });
  }

  // 术语缺失
  for (const term of opts.glossaryMissing ?? []) {
    issues.push({ level: 'soft', code: 'glossary', message: `术语缺失：原文含「${term}」但译文未出现其强制译法` });
  }

  return issues;
}

/** 便捷：硬问题是否存在（决定标 conflict） */
export function hasHardIssue(issues: readonly QualityIssue[]): boolean {
  return issues.some((i) => i.level === 'hard');
}

/** 汇总软警告计数（按 code 聚合） */
export function summarizeSoft(issues: readonly QualityIssue[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of issues) {
    if (i.level === 'soft') out[i.code] = (out[i.code] ?? 0) + 1;
  }
  return out;
}
