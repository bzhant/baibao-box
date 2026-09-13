/**
 * Ren'Py `.rpy` 脚本解析（适配器里最难的一块）。
 *
 * 为什么不能拿正则硬扫：
 *   - 字符串里可能出现 `#`（`"价格 #1"`），不能当注释切掉；
 *   - 字符串里可能出现转义引号（`"他说 \"你好\"。"`），会截断匹配；
 *   - 一行可能有多个字符串（`define e = Character("Eileen", color="#fff")`），
 *     必须知道"第几个"才是要翻的。
 * 所以这里写一个**字符串感知**的扫描器：先切出所有字面量并记录位置，
 * 再把字面量换成占位符得到"代码骨架"，最后**按骨架判语句类型**——而不是按原文本。
 *
 * 设计要点（与 MV/MZ 适配器一致）：
 *   每个可翻译槽位用 `行号 + 该行第几个字面量` 定位，
 *   repack 时**重新解析同一行**再原地替换，因此行号不会因回写而失效。
 *
 * 本文件刻意零依赖（便于 `node --experimental-strip-types` 直跑自检）。
 */

export type RpyKind = 'narration' | 'say' | 'choice' | 'name' | 'extend';

export interface RpySlot {
  /** 1-based 行号 */
  line: number;
  /** 该行内第几个字符串字面量（0-based） */
  ordinal: number;
  kind: RpyKind;
  /** 原文（**逐字保留**，含转义，保证可无损回写） */
  source: string;
}

interface Lit {
  /** 引号内的原始内容（逐字） */
  raw: string;
  /** 起始引号的下标 */
  start: number;
  /** 结束引号之后的下标 */
  end: number;
  /** 内容起始下标（跳过起始引号，三引号安全） */
  innerStart: number;
  /** 内容结束下标（结束引号位置） */
  innerEnd: number;
}

/** 语句关键字：行首是这些词时，不当作"角色对白" */
const NON_SAY_KEYWORDS = new Set([
  'play', 'stop', 'queue', 'show', 'scene', 'hide', 'image', 'jump', 'call', 'label',
  'menu', 'if', 'elif', 'else', 'while', 'for', 'python', 'init', 'screen', 'style',
  'transform', 'translate', 'voice', 'window', 'pause', 'return', 'pass', 'define',
  'default', 'with', 'at', 'from', 'expression', 'use', 'on', 'add', 'old', 'new',
  'contains', 'function', 'layer', 'preferences', 'input', 'null', 'vbox', 'hbox',
  'frame', 'grid', 'fixed', 'viewport', 'side', 'key', 'timer', 'bar', 'button',
  'imagebutton', 'text', 'textbutton', 'nvl', 'centered', 'vcentered', 'say',
  'imagemap', 'hotspot', 'draggroup', 'drag', 'mousedrop', 'predict', 'camera',
]);

/**
 * 切出所有字符串字面量（支持 \" \\ 转义 与 """三引号"""），
 * 并把每个字面量替换成占位符 '§' 得到"代码骨架"。
 * allClosed=false 表示遇到未闭合字面量（如跨行三引号），调用方应保守跳过该行。
 */
export function splitLiterals(line: string): { lits: Lit[]; allClosed: boolean; skeleton: string } {
  const lits: Lit[] = [];
  let allClosed = true;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const triple = c === '"' && line.startsWith('"""', i);
      const openLen = triple ? 3 : 1;
      const close = triple ? '"""' : c;
      let j = i + openLen;
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line.startsWith(close, j)) { closed = true; break; }
        j++;
      }
      if (!closed) { allClosed = false; break; }
      lits.push({
        raw: line.slice(i + openLen, j),
        start: i,
        end: j + close.length,
        innerStart: i + openLen,
        innerEnd: j,
      });
      i = j + close.length;
    } else {
      i++;
    }
  }

  let skeleton = '';
  let cursor = 0;
  for (const l of lits) {
    skeleton += line.slice(cursor, l.start) + '§';
    cursor = l.end;
  }
  skeleton += line.slice(cursor);
  return { lits, allClosed, skeleton };
}

/** 去掉行尾注释——只认"字符串之外"的 `#` */
export function stripComment(line: string): string {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '"' || c === "'") {
      const triple = c === '"' && line.startsWith('"""', i);
      const close = triple ? '"""' : c;
      let j = i + (triple ? 3 : 1);
      let closed = false;
      while (j < line.length) {
        if (line[j] === '\\') { j += 2; continue; }
        if (line.startsWith(close, j)) { closed = true; break; }
        j++;
      }
      if (!closed) return line; // 未闭合：保守，不截断
      i = j + close.length;
      continue;
    }
    if (c === '#') return line.slice(0, i);
    i++;
  }
  return line;
}

/** 解析单行，返回可翻译槽位（无可翻译内容返回 null） */
export function parseRpyLine(rawLine: string, lineNo: number): RpySlot | null {
  const line = stripComment(rawLine);
  if (!line.trim()) return null;

  const { lits, allClosed, skeleton } = splitLiterals(line);
  if (!allClosed || lits.length === 0) return null;

  const sk = skeleton.trim();
  const last = lits.length - 1;
  const slot = (kind: RpyKind, ordinal: number): RpySlot => ({
    line: lineNo, ordinal, kind, source: lits[ordinal].raw,
  });

  // 1) 菜单选项："文本":
  if (/^§\s*:\s*$/.test(sk)) return slot('choice', 0);

  // 2) 角色显示名：define/default x = Character("Name", …)
  if (/^(define|default)\s+\w+\s*=\s*Character\s*\(/.test(sk)) return slot('name', 0);

  // 3) extend "…"（接续上一句对白）
  if (/^extend\s+§\s*$/.test(sk)) return slot('extend', last);

  // 去掉行尾 (with …) 再判旁白/对白
  const skNoWith = sk.replace(/\s+with\s+.*$/, '');

  // 4) 旁白：整行只有一句
  if (/^§$/.test(skNoWith)) return slot('narration', 0);

  // 5) 角色对白：标识符 (属性…) "文本"   —— 对白恒为该行**最后一个**字符串
  const m = skNoWith.match(/^([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*§$/);
  if (m && !NON_SAY_KEYWORDS.has(m[1])) return slot('say', last);

  return null;
}

/** 抽取整个 .rpy 文本里的可翻译槽位 */
export function extractRpySlots(text: string): RpySlot[] {
  const out: RpySlot[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = parseRpyLine(lines[i], i + 1);
    if (s) out.push(s);
  }
  return out;
}

/**
 * 把译文写成可安全放进 `.rpy` 字面量的形式：
 * 只转义**未转义的** `"`（已转义的 `\"` 原样保留）。
 * 不做反斜杠加倍——这样 `\n` 这类 Ren'Py 转义能原样生效，且原文可无损 round-trip。
 */
export function escapeForRpy(text: string): string {
  return text.replace(/(?<!\\)"/g, '\\"');
}

/**
 * 重写某一行的第 ordinal 个字面量为 newText。
 * 返回新的整行；若该行解析不出或序号越界则返回 null（调用方跳过，不写坏文件）。
 */
export function replaceRpyLiteral(rawLine: string, ordinal: number, newText: string): string | null {
  const line = stripComment(rawLine);
  const { lits, allClosed } = splitLiterals(line);
  if (!allClosed || ordinal < 0 || ordinal >= lits.length) return null;
  const lit = lits[ordinal];
  return line.slice(0, lit.innerStart) + escapeForRpy(newText) + line.slice(lit.innerEnd);
}
