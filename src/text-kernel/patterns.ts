/**
 * text-kernel · 各引擎的控制符模式
 *
 * 这是"通用内核 + 每引擎薄适配"里的"薄"那层：
 * 控制符的**处理逻辑**（mask/unmask/质检）只有一份，各引擎只贡献**模式**。
 *
 * 用法：const { masked, tokens } = mask(src, patternFor('renpy'));
 */

/** RPG Maker 系：\N[1] \V[2] \C[3] \{ \} \G \\ 以及类 HTML 标签 <tag> */
export const RM_PATTERN = /(\\[A-Za-z](?:\[[^\]]*\])?|\\[{}$.|!<>^\\]|<[^>]+>)/g;

/**
 * Ren'Py：
 *   [varname]   —— 文本插值（`[[` 是转义的字面 `[`，这里刻意不匹配，保持原样）
 *   {tag}       —— 文本标签，如 {b}粗体{/b}、{color=#f00}、{w}、{}（转义）
 */
export const RENPY_PATTERN = /(\[[^\[\]]*\]|\{[^{}]*\})/g;

/** KiriKiri：形如 [ruby text="…"]、[wait time=100]、[link] */
export const KIRIKIRI_PATTERN = /(\[[^\[\]]*\])/g;

/** 引擎 id -> 控制符模式 */
export const ENGINE_PATTERNS: Record<string, RegExp> = {
  mvmz: RM_PATTERN,
  renpy: RENPY_PATTERN,
  krkr: KIRIKIRI_PATTERN,
};

/** 取某引擎的控制符模式；未知引擎回退到 RPG Maker 模式 */
export function patternFor(engineId: string): RegExp {
  return ENGINE_PATTERNS[engineId] ?? RM_PATTERN;
}
