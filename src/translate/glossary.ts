/**
 * 术语表（强制名词替换）。
 *
 * 解决一个真实痛点：人名/地名/专有名词在不同批次会被机翻翻得**不一致**
 * （"アーサー"一会儿"亚瑟"一会儿"阿瑟"），而且没法强制。
 *
 * 做法不是"翻完再替换"（那不可靠），而是 **送机翻前就把术语掩码成稳定占位符**：
 *
 *     アーサーは伝説の剣を持つ     ──glossary: {アーサー→亚瑟, 伝説の剣→传说之剑}
 *  →  __GT0__は__GT1__を持つ          （送机翻；占位符会原样保留）
 *  →  __GT0__挥舞着__GT1__            （机翻输出）
 *  →  亚瑟挥舞着传说之剑             （按占位符**强制**还原成指定译文）
 *
 * 这样人名/地名**逐条都一致**，且不依赖机翻"自觉"。
 *
 * 与控制符掩码（control-codes.ts）配合：控制符占位 `__BBn__`、术语占位 `__GTn__`，
 * 两者不冲突（一个 ASCII 前缀不同），还原顺序任意。
 */

export interface GlossaryEntry {
  /** 原文术语 */
  source: string;
  /** 强制目标译文 */
  target: string;
  /** 是否区分大小写（默认 true；CJK 无所谓，拉丁系有用） */
  caseSensitive?: boolean;
}

export type Glossary = Record<string, string> | GlossaryEntry[];

/** 统一成 GlossaryEntry[]，并按原文长度降序排（长词优先，避免"火"抢走"火炎"的前缀） */
export function normalizeGlossary(g: Glossary | undefined | null): GlossaryEntry[] {
  if (!g) return [];
  const list: GlossaryEntry[] = Array.isArray(g)
    ? g.slice()
    : Object.entries(g).map(([source, target]) => ({ source, target }));
  return list
    .filter((e) => e && e.source && e.target)
    .sort((a, b) => b.source.length - a.source.length);
}

export interface GlossaryMask {
  masked: string;
  /** 占位符 -> 强制译文（还原用） */
  map: Array<{ ph: string; target: string }>;
}

/** 术语占位符生成器 */
export type GlossaryPh = (index: number) => string;

export const defaultGlossaryPh: GlossaryPh = (i) => `__GT${i}__`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把文本里的术语全部掩码成占位符。
 * 大小写不敏感时仍按原文**首次出现的大小写形态**替换（占位符本身无大小写问题）。
 */
export function maskGlossary(
  text: string,
  entries: GlossaryEntry[],
  ph: GlossaryPh = defaultGlossaryPh,
): GlossaryMask {
  const map: Array<{ ph: string; target: string }> = [];
  let out = text;
  let idx = 0;

  for (const e of entries) {
    const flags = e.caseSensitive === false ? 'gi' : 'g';
    const re = new RegExp(escapeRegExp(e.source), flags);
    if (!re.test(out)) continue;
    const placeholder = ph(idx);
    idx++;
    map.push({ ph: placeholder, target: e.target });
    out = out.replace(re, placeholder);
  }
  return { masked: out, map };
}

/** 按占位符把文本还原成强制译文。 */
export function unmaskGlossary(masked: string, map: readonly { ph: string; target: string }[]): string {
  let out = masked;
  for (const m of map) {
    out = out.split(m.ph).join(m.target);
  }
  return out;
}

/**
 * 后校验：原文里有某个术语、但译文里没有出现它的强制译文 → 该术语缺失。
 * 用于质检（当我们**没有**对这句做掩码时的兜底，比如 Provider 自带翻译记忆）。
 */
export function missingGlossaryTerms(
  source: string,
  translated: string,
  entries: GlossaryEntry[],
): string[] {
  const missing: string[] = [];
  for (const e of entries) {
    if (source.includes(e.source) && !translated.includes(e.target)) {
      missing.push(e.source);
    }
  }
  return missing;
}
