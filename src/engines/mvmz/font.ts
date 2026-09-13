import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  applyPatch,
  restoreLatest,
  relPath,
  type PatchManifest,
  type PatchFileInput,
} from '@platform/patch';
import { checkCoverage, pickCjkStack } from '@platform/fonts';

/**
 * MV/MZ 中文字体注入 —— 解决"译文变方框"。
 *
 * 机制的结论**全部来自对真实游戏与引擎源码的实测**，不是猜的：
 *
 * ── MV ──────────────────────────────────────────────────────
 * `rpg_windows.js` 里写死了语言分支：
 *     Window_Base.prototype.standardFontFace = function() {
 *         if ($gameSystem.isChinese()) return 'SimHei, Heiti TC, sans-serif';
 *         else if ($gameSystem.isKorean()) return 'Dotum, AppleGothic, sans-serif';
 *         else return 'GameFont';
 *     };
 * 而 `isChinese()` 是纯数据的：`return $dataSystem.locale.match(/^zh/)`。
 * → 所以 **只把 System.json 的 locale 改成 zh_CN**，引擎自己就切到系统黑体，
 *   中文直接能显示，**不需要复制任何字体文件**。
 * （加固项：把 fonts/gamefont.css 里 GameFont 的 src 前置 local() 系统字体，
 *   万一某些游戏把 standardFontFace 改回 GameFont 也仍然有中文兜底。）
 *
 * ── MZ ──────────────────────────────────────────────────────
 * `rmmz_objects.js`：
 *     Game_System.prototype.mainFontFace = function() {
 *         return "rmmz-mainfont, " + $dataSystem.advanced.fallbackFonts;
 *     };
 * `rmmz_scenes.js` 只把 mainFontFilename / numberFontFilename 注册成 rmmz-mainfont。
 * → 所以 **只改 System.json 的 advanced.fallbackFonts**，把它设成中文字体栈，
 *   浏览器就会在 rmmz-mainfont（日文字体，缺汉字）找不到字形时回退到系统中文字体。
 *   同样**不需要复制字体文件**。
 *
 * 两者都是**纯数据/CSS 改动**、可一键还原，且不涉及任何字体再分发（无版权问题）。
 * 对比：有的做法是把 CJK 字体文件复制进游戏并替换 gamefont.css 的 src。
 */

/** 默认中文字体栈：优先系统自带，覆盖简繁 */
export const DEFAULT_CJK_STACK =
  'Microsoft YaHei, SimHei, Noto Sans SC, PingFang SC, Heiti TC, Microsoft JhengHei, sans-serif';

/** 候选中文字体（按优先级），用于"在本机挑一个真能显示的" */
export const CJK_CANDIDATES = [
  'Microsoft YaHei',
  'Microsoft YaHei UI',
  'SimHei',
  'Noto Sans SC',
  'Source Han Sans SC',
  'DengXian',
  'SimSun',
  'PingFang SC',
  'Microsoft JhengHei',
  'Heiti TC',
] as const;

export type MvzKind = 'MV' | 'MZ';

export interface MvzLayout {
  kind: MvzKind;
  /** 资源根目录（发布态是 <gameDir>/www，根布局就是 <gameDir>） */
  wwwDir: string;
  dataDir: string;
  systemJson: string;
  jsDir: string;
}

/** 判定 MV / MZ 并定位资源目录。权威依据是引擎核心 js 文件名。 */
export async function detectMvzLayout(gameDir: string): Promise<MvzLayout | null> {
  for (const wwwDir of [join(gameDir, 'www'), gameDir]) {
    const jsDir = join(wwwDir, 'js');
    const exists = async (p: string) => {
      try {
        await fs.stat(p);
        return true;
      } catch {
        return false;
      }
    };
    const hasMZ = await exists(join(jsDir, 'rmmz_core.js'));
    const hasMV = await exists(join(jsDir, 'rpg_core.js'));
    if (!hasMZ && !hasMV) continue;
    const dataDir = join(wwwDir, 'data');
    const systemJson = join(dataDir, 'System.json');
    if (!(await exists(systemJson))) continue;
    return { kind: hasMZ ? 'MZ' : 'MV', wwwDir, dataDir, systemJson, jsDir };
  }
  return null;
}

/**
 * 在 gamefont.css 里给 GameFont 的 src 前置 local() 系统字体。
 * 幂等：已含 local( 则原样返回。保留原字体作为最后一档兜底。
 */
export function prependLocalToGameFont(
  css: string,
  locals: readonly string[] = ['Microsoft YaHei', 'SimHei', 'Heiti TC'],
): string {
  const blockRe = /@font-face\s*\{[^}]*font-family\s*:\s*GameFont\s*;[^}]*\}/i;
  const block = css.match(blockRe)?.[0];
  if (!block) return css;
  const srcRe = /src\s*:\s*([^;]+);/i;
  const src = block.match(srcRe)?.[1];
  if (!src || /local\(/i.test(src)) return css;
  const localsStr = locals.map((l) => `local("${l}")`).join(', ');
  const newBlock = block.replace(srcRe, `src: ${localsStr}, ${src.trim()};`);
  return css.replace(block, newBlock);
}

export interface FontInjectResult {
  kind: MvzKind;
  /** null 表示无需改动（已注入过） */
  manifest: PatchManifest | null;
  notes: string[];
  alreadyApplied: boolean;
  /**
   * **字形覆盖校验**结果（仅在调用时给了 `sampleText` 才有）。
   * 这是"能看"的保证：确认这台机器上真有字体能显示译文里的每个字，
   * 而不是配好了字体名却渲染成豆腐块。
   */
  coverage?: {
    /** 依次尝试的字体（与 CSS font-family 同语义） */
    stack: string[];
    /** 本机没有任何候选字体能显示的字符 */
    missing: string[];
    ok: boolean;
  };
}

/** 注入中文字体支持。返回改动清单；可随时 restoreCjkFont 还原。 */
export async function injectCjkFont(
  gameDir: string,
  opts: { cjkStack?: string; patchGameFontCss?: boolean; sampleText?: string } = {},
): Promise<FontInjectResult> {
  const layout = await detectMvzLayout(gameDir);
  if (!layout) {
    throw new Error('[font] 不是 MV/MZ 游戏：找不到 js/rmmz_core.js 或 js/rpg_core.js 且缺 data/System.json');
  }

  const notes: string[] = [];
  const files: PatchFileInput[] = [];
  let coverage: FontInjectResult['coverage'];
  let stack = opts.cjkStack ?? DEFAULT_CJK_STACK;

  // ① MZ：按"本机实测能覆盖译文"的顺序挑字体，而不是拍脑袋写个栈
  if (layout.kind === 'MZ' && !opts.cjkStack && opts.sampleText) {
    const picked = await pickCjkStack(opts.sampleText, CJK_CANDIDATES);
    if (picked.stack.length > 0) {
      // 把实测可用的字体放最前面，后面保留通用栈兜底
      stack = `${picked.stack.join(', ')}, ${DEFAULT_CJK_STACK}`;
      notes.push(`按本机实测挑选字体：${picked.stack.join(', ')}（这些确实覆盖了译文用字）`);
    }
  }

  // ② 覆盖校验：引擎最终会用哪套字体，就校验哪套
  if (opts.sampleText) {
    const engineStack =
      layout.kind === 'MV'
        ? // MV 引擎内置分支写死的完整列表 —— 末尾的 sans-serif 不能漏，
          // 浏览器最终会靠它回退到符号字体（实测 ♥♡・Ⅿ 就是靠它兜住的）
          ['SimHei', 'Heiti TC', 'sans-serif']
        : stack
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    const r = await checkCoverage(opts.sampleText, engineStack);
    coverage = { stack: r.tried, missing: r.missing, ok: r.missing.length === 0 };
    const charKinds = new Set([...opts.sampleText].filter((c) => c.trim() !== '')).size;
    notes.push(
      r.missing.length === 0
        ? `✓ 字形覆盖校验通过：${r.tried.slice(0, 3).join(' / ')} 能完整显示译文（${charKinds} 种字符）`
        : `⚠ 字形覆盖校验**未通过**：${r.missing.length} 个字符在本机找不到能显示的字体 ` +
          `→ ${r.missing.slice(0, 20).join('')}（这些字会变成豆腐块）`,
    );
  }

  let sys: Record<string, unknown>;
  try {
    sys = JSON.parse(await fs.readFile(layout.systemJson, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`[font] 读取 System.json 失败: ${(err as Error).message}`);
  }
  const sysRel = relPath(gameDir, layout.systemJson);

  if (layout.kind === 'MZ') {
    const advanced = (sys.advanced ?? {}) as Record<string, unknown>;
    const before = advanced.fallbackFonts;
    advanced.fallbackFonts = stack;
    sys.advanced = advanced;
    files.push({ rel: sysRel, content: JSON.stringify(sys) });
    notes.push(
      `MZ：advanced.fallbackFonts ${JSON.stringify(before)} → 中文字体栈（mainFontFace() 拼成 "rmmz-mainfont, <栈>"，` +
        '汉字由浏览器回退到系统中文字体渲染）',
    );
  } else {
    const before = sys.locale;
    sys.locale = 'zh_CN';
    files.push({ rel: sysRel, content: JSON.stringify(sys) });
    notes.push(
      `MV：locale ${JSON.stringify(before)} → "zh_CN"，触发引擎内置分支 ` +
        "standardFontFace() 返回 'SimHei, Heiti TC, sans-serif'",
    );

    if (opts.patchGameFontCss !== false) {
      const cssAbs = join(layout.wwwDir, 'fonts', 'gamefont.css');
      try {
        const css = await fs.readFile(cssAbs, 'utf8');
        const patched = prependLocalToGameFont(css);
        if (patched !== css) {
          files.push({ rel: relPath(gameDir, cssAbs), content: patched });
          notes.push('MV 加固：gamefont.css 的 GameFont 前置 local() 系统字体，原字体保留为兜底（不复制字体文件）');
        } else {
          notes.push('MV：gamefont.css 已加固或无需改动');
        }
      } catch {
        notes.push('MV：未找到 fonts/gamefont.css，跳过 CSS 加固');
      }
    }
  }

  const manifest = await applyPatch(gameDir, { label: 'font', engine: 'mvmz', files });
  const alreadyApplied = manifest.changes.length === 0;
  if (alreadyApplied) notes.push('已是目标状态，未产生改动');
  return {
    kind: layout.kind,
    manifest: alreadyApplied ? null : manifest,
    notes,
    alreadyApplied,
    coverage,
  };
}

/** 还原最近一次字体注入 */
export async function restoreCjkFont(gameDir: string) {
  return restoreLatest(gameDir, 'font');
}

/** 查询当前字体注入状态（不修改任何文件） */
export async function checkFontStatus(
  gameDir: string,
): Promise<{ kind: MvzKind; locale?: unknown; fallbackFonts?: unknown } | null> {
  const layout = await detectMvzLayout(gameDir);
  if (!layout) return null;
  try {
    const sys = JSON.parse(await fs.readFile(layout.systemJson, 'utf8')) as Record<string, unknown>;
    const advanced = (sys.advanced ?? {}) as Record<string, unknown>;
    return { kind: layout.kind, locale: sys.locale, fallbackFonts: advanced.fallbackFonts };
  } catch {
    return { kind: layout.kind };
  }
}
