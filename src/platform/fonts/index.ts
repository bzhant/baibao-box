import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parseFontFile, missingChars, type FontFace } from './ttf';

/**
 * 系统字体发现 + **字形覆盖校验**。
 *
 * 为什么需要：我们给游戏注入字体（MV 改 `locale`、MZ 改 `fallbackFonts`）时，
 * 写进去的是**字体名**。如果这个名字在本机匹配不上，或者那个字体根本没收录译文里的字，
 * 结果是**豆腐块** —— 游戏能启动、文本也"在"，但玩家看不见。
 *
 * 判断：排版回填（含缺字兜底）是"能看"和"能用"的分界线。
 * 这里做的就是把它**可验证化**：注入前先确认字体真实存在、且真的收录了要显示的字符。
 */

const WIN_FONT_DIRS = ['C:/Windows/Fonts', 'C:/WINNT/Fonts'];

let cache: FontFace[] | null = null;

/** 清缓存（测试用） */
export function resetFontCache(): void {
  cache = null;
}

/** 扫描系统字体目录并解析每个 face（结果缓存） */
export async function loadSystemFonts(dirs: string[] = WIN_FONT_DIRS): Promise<FontFace[]> {
  if (cache) return cache;
  const faces: FontFace[] = [];
  for (const dir of dirs) {
    let names: string[] = [];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!lower.endsWith('.ttf') && !lower.endsWith('.ttc') && !lower.endsWith('.otf')) continue;
      try {
        const buf = await fs.readFile(join(dir, name));
        for (const f of parseFontFile(buf)) {
          if (f.family && f.codepoints.size > 0) faces.push({ ...f, family: f.family });
        }
      } catch {
        /* 单个字体读失败不影响整体 */
      }
    }
  }
  cache = faces;
  return faces;
}

/** 按 family 名查字体（大小写不敏感；返回覆盖字符数最多的那个） */
export function findFont(faces: readonly FontFace[], family: string): FontFace | undefined {
  const want = family.trim().toLowerCase();
  const hit = faces.filter((f) => f.family.toLowerCase() === want);
  if (hit.length === 0) return undefined;
  return hit.sort((a, b) => b.codepoints.size - a.codepoints.size)[0];
}

export interface CoverageReport {
  /** 依次尝试的字体名 */
  tried: string[];
  /** 第一个能覆盖全部字符的字体名（null = 都不行） */
  coveredBy: string | null;
  /** 最终仍缺的字符 */
  missing: string[];
}

/**
 * 通用族名（CSS generic family）在 Windows 上浏览器实际会回退到哪些字体。
 *
 * 为什么必须考虑：MV 的字体栈结尾是 `sans-serif`。浏览器找不到字形时会
 * **一路回退**（包括 Segoe UI Symbol 这类符号字体），所以只用 SimHei 判断
 * "♥ 能不能显示"会**误报缺字** —— 实测就误报过 `・♡Ⅿ♥`。
 */
const GENERIC_FALLBACKS: Record<string, readonly string[]> = {
  'sans-serif': ['Arial', 'Microsoft YaHei UI', 'MS Gothic', 'Segoe UI Symbol'],
  serif: ['Times New Roman', 'SimSun', 'MS Mincho'],
  monospace: ['Consolas', 'Courier New'],
  system: ['Microsoft YaHei UI', 'Segoe UI'],
};

/**
 * 校验一串文本能否被给定字体序列完整渲染。
 * 语义与 CSS `font-family` 一致：**按顺序取第一个覆盖该字的字体**；
 * 遇到通用族名时按 `GENERIC_FALLBACKS` 展开。
 */
export async function checkCoverage(
  text: string,
  fontFamilies: readonly string[],
  faces?: readonly FontFace[],
): Promise<CoverageReport> {
  const list = faces ?? (await loadSystemFonts());
  const tried: string[] = [];
  const missing = new Set<string>();

  // 合并所有候选字体的覆盖范围：只要有一个字体能显示这个字，就不是豆腐块
  const union = new Set<number>();
  const addFamily = (fam: string): void => {
    const f = findFont(list, fam);
    if (!f) return;
    for (const cp of f.codepoints) union.add(cp);
  };
  for (const fam of fontFamilies) {
    tried.push(fam);
    addFamily(fam);
    for (const rep of GENERIC_FALLBACKS[fam.trim().toLowerCase()] ?? []) addFamily(rep);
  }

  for (const ch of missingChars(union, text)) missing.add(ch);
  return {
    tried,
    coveredBy: missing.size === 0 && union.size > 0 ? tried.join(', ') : null,
    missing: [...missing],
  };
}

/**
 * 从系统里挑一个**能覆盖给定文本**的中文字体栈。
 * 用于注入游戏配置前先自证："这台机器上确实显示得出来"。
 */
export async function pickCjkStack(
  sampleText: string,
  preferred: readonly string[],
  faces?: readonly FontFace[],
): Promise<{ stack: string[]; report: CoverageReport }> {
  const list = faces ?? (await loadSystemFonts());
  const stack: string[] = [];
  const remaining = new Set(missingChars(new Set<number>(), sampleText));

  for (const fam of preferred) {
    const f = findFont(list, fam);
    if (!f) continue;
    stack.push(f.family);
    for (const ch of [...remaining]) {
      if (f.codepoints.has(ch.codePointAt(0)!)) remaining.delete(ch);
    }
    if (remaining.size === 0) break;
  }

  const report = await checkCoverage(sampleText, stack, list);
  return { stack, report };
}
