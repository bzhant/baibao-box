/**
 * text-kernel · 控制符 token 化
 *
 * 游戏文本里混着大量"控制符"（RPG Maker 的 \N[1] \V[2] \C[3] \{ \}、
 * 其它引擎的 <tag> {var} 等）。这些**绝不能送进机器翻译**——会被翻坏、
 * 翻译完游戏就崩。正确做法：翻译前把它们 token 化占位，翻完按序号还原。
 *
 * 本模块保证两条不变量（有测试锁定）：
 *   1. 无损切分：tokenize 后把所有片段拼回去 === 原文
 *   2. 可还原：  unmask(mask(x).masked, tokens) === x
 */

export interface Segment {
  kind: 'text' | 'token';
  value: string;
}

/**
 * 默认控制符模式（覆盖 RPG Maker 系 + 常见 <tag>）：
 *   \\X[...]   带参控制符，如 \V[12] \N[3] \C[4] \I[7]
 *   \\X        无参控制符，如 \G \{ \}（字母或符号）
 *   \\         字面反斜杠
 *   <...>      类 HTML 标签（其它引擎用）
 */
export const DEFAULT_PATTERN =
  /(\\[A-Za-z](?:\[[^\]]*\])?|\\[{}$.|!<>^\\]|<[^>]+>)/g;

/** 把文本无损切分为 文本段 / 控制符段。拼回所有 value === 原文。 */
export function tokenize(src: string, pattern: RegExp = DEFAULT_PATTERN): Segment[] {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g',
  );
  const segs: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) segs.push({ kind: 'text', value: src.slice(last, m.index) });
    segs.push({ kind: 'token', value: m[0] });
    last = m.index + m[0].length;
  }
  if (last < src.length) segs.push({ kind: 'text', value: src.slice(last) });
  return segs;
}

/** 占位符生成器：把第 i 个控制符换成一个机器翻译"懒得动"的占位串。 */
export type PlaceholderFn = (index: number) => string;

/**
 * 默认占位：字母+数字+下划线组合，主流 MT（Google/DeepL/OpenAI）通常原样保留。
 * 不同 Provider 对占位符的"存活率"不同，必要时应按 Provider 覆盖。
 */
export const defaultPlaceholder: PlaceholderFn = (i) => `__BB${i}__`;

export interface MaskedText {
  /** 控制符已被占位替换、可安全送 MT 的文本 */
  masked: string;
  /** 被换下的控制符原文（按序），unmask 时按序号还原 */
  tokens: string[];
}

/** 翻译前：把控制符全部占位。 */
export function mask(
  src: string,
  pattern: RegExp = DEFAULT_PATTERN,
  ph: PlaceholderFn = defaultPlaceholder,
): MaskedText {
  const segs = tokenize(src, pattern);
  const tokens: string[] = [];
  const masked = segs
    .map((s) => {
      if (s.kind === 'text') return s.value;
      tokens.push(s.value);
      return ph(tokens.length - 1);
    })
    .join('');
  return { masked, tokens };
}

/** 翻译后：按序号把占位符还原为原控制符。 */
export function unmask(
  masked: string,
  tokens: string[],
  ph: PlaceholderFn = defaultPlaceholder,
): string {
  let out = masked;
  for (let i = 0; i < tokens.length; i++) {
    out = out.split(ph(i)).join(tokens[i]);
  }
  return out;
}

/**
 * 质量自检：机翻返回后，检查占位符是否被翻坏/丢失。
 * 返回缺失的占位序号（空数组 = 全部完好）。
 */
export function missingPlaceholders(
  translated: string,
  tokenCount: number,
  ph: PlaceholderFn = defaultPlaceholder,
): number[] {
  const missing: number[] = [];
  for (let i = 0; i < tokenCount; i++) {
    if (!translated.includes(ph(i))) missing.push(i);
  }
  return missing;
}

export function placeholdersIntact(text: string, count: number): boolean {
  const found = text.match(/__BB\d+__/g) ?? [];
  return found.length === count &&
    Array.from({ length: count }, (_, i) => defaultPlaceholder(i))
      .every((p) => found.filter((f) => f === p).length === 1);
}

/** Manual edits and imported translations must obey the same control-code contract. */
export function controlCodesIntact(source: string, translated: string, pattern: RegExp = DEFAULT_PATTERN): boolean {
  const tokens = (s: string): string[] => tokenize(s, pattern)
    .filter((s) => s.kind === 'token').map((s) => s.value).sort();
  return translated.trim().length > 0 &&
    !/__BB\d+__|__GT\d+__/.test(translated) &&
    JSON.stringify(tokens(source)) === JSON.stringify(tokens(translated));
}
