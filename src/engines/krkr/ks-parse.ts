/**
 * KiriKiri `.ks` 场景脚本解析。
 *
 * 设计哲学与 Ren'Py 解析器一致：**字符串感知 + 保守抽取**。
 *   一行被切成「文本段 / 标签 / 注释 / 标签行 / 命令」，
 *   **只抽取"文本段"**，其余原样保留。
 *
 * 这样即使我们对某些 KiriKiri 标签不够了解（没拿到真样本前不敢说全懂），
 * 也不会破坏脚本 —— 不认识的构造一律穿透过，**回写时逐字节还原**。
 *
 * `.ks` 常见构造：
 *   ;注释        → 注释（跳过）
 *   *label       → 标签（跳过）
 *   @命令 / @TJS → 命令（跳过）
 *   普通行        → 对白，可含内联标签 [r] [p] [l] [emb exp="…"] 等
 */

export type KsEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'shift_jis' | 'euc-jp' | 'gbk';

export type SegType = 'text' | 'tag' | 'comment' | 'label' | 'command';

export interface KsSegment {
  type: SegType;
  value: string;
  start: number;
  end: number;
}

/** 一条可译文本：行号 + 该行内第几个"文本段" */
export interface KsSlot {
  line: number; // 1 基
  ordinal: number; // 该行内第几个 text 段（0 基）
  source: string;
}

// ── 编码 ──────────────────────────────────────────────────────

/** 猜测 `.ks` 编码：BOM 优先，其次 UTF-8 合法性，退回 Shift-JIS。 */
export function detectEncoding(buf: Buffer): KsEncoding {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8-bom';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  if (!buf.toString('utf8').includes('\uFFFD')) return 'utf-8';
  return 'shift_jis';
}

/** 解码（读方向用内置 TextDecoder，Node 支持 shift_jis / euc-jp / gbk） */
export function decodeKs(buf: Buffer): { text: string; encoding: KsEncoding } {
  const encoding = detectEncoding(buf);
  const decoder = new TextDecoder(encoding === 'utf-8-bom' ? 'utf-8' : encoding);
  return { text: decoder.decode(buf).replace(/^\uFEFF/, ''), encoding };
}

/**
 * 编码（写方向）。UTF-8 / UTF-16 用内置能力；
 * Shift-JIS 等需要 iconv-lite（Node 的 TextEncoder 只支持 UTF-8）。
 *
 * ⚠️ **有损检测**：像「Shift-JIS 的日文游戏翻成简体中文」这种场景，
 * Shift-JIS 里根本没有「汉」「中」这些简体字，iconv 会**静默**把它们变成 `?`。
 * 所以编码后必须解码回来比对，发现不一致就如实报告 `lossy: true`，
 * 由调用方决定降级策略（本项目：改用 UTF-8 with BOM）。
 */
export async function encodeKs(
  text: string,
  encoding: KsEncoding,
): Promise<{ buf: Buffer; lossy: boolean }> {
  switch (encoding) {
    case 'utf-8':
      return { buf: Buffer.from(text, 'utf8'), lossy: false };
    case 'utf-8-bom':
      return {
        buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]),
        lossy: false,
      };
    case 'utf-16le':
      return {
        buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]),
        lossy: false,
      };
    default: {
      let iconv: { encode: (s: string, enc: string) => Buffer };
      try {
        iconv = (await import('iconv-lite')) as unknown as {
          encode: (s: string, enc: string) => Buffer;
        };
      } catch {
        throw new Error(
          `回写 ${encoding} 编码需要 iconv-lite（Node 的 TextEncoder 只支持 UTF-8）。` +
            '请先 npm i iconv-lite —— 在装好之前拒绝回写，以免把游戏脚本写坏。',
        );
      }
      const buf = iconv.encode(text, encoding);
      // 有损检测：解回来对不上，说明有字符该编码表示不了
      let lossy = false;
      try {
        lossy = new TextDecoder(encoding).decode(buf) !== text;
      } catch {
        lossy = true;
      }
      return { buf, lossy };
    }
  }
}

// ── 切分 ──────────────────────────────────────────────────────

/** 把一行切成若干段（注释/标签行/命令整体成一段，普通行按 [] 标签切分） */
export function splitLine(line: string): KsSegment[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith(';')) return [{ type: 'comment', value: line, start: 0, end: line.length }];
  if (trimmed.startsWith('*')) return [{ type: 'label', value: line, start: 0, end: line.length }];
  if (trimmed.startsWith('@')) return [{ type: 'command', value: line, start: 0, end: line.length }];

  const segs: KsSegment[] = [];
  const re = /\[[^\]]*\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      segs.push({ type: 'text', value: line.slice(last, m.index), start: last, end: m.index });
    }
    segs.push({ type: 'tag', value: m[0], start: m.index, end: m.index + m[0].length });
    last = m.index + m[0].length;
  }
  if (last < line.length) segs.push({ type: 'text', value: line.slice(last), start: last, end: line.length });
  return segs;
}

/** 是否值得翻译：非空、含文字或数字（纯符号"———"之类不翻） */
export function isTranslatable(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return /[\p{L}\p{N}]/u.test(t);
}

/** 抽取整个脚本的可译文本 */
export function extractKsText(text: string): KsSlot[] {
  const out: KsSlot[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // 去掉行尾 \r 再切分，避免把 \r 算进文本段
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    let ordinal = 0;
    for (const s of splitLine(line)) {
      if (s.type !== 'text') continue;
      const idx = ordinal++;
      if (isTranslatable(s.value)) out.push({ line: i + 1, ordinal: idx, source: s.value });
    }
  }
  return out;
}

/** 把某行第 ordinal 个"文本段"替换为新文本；定位失败返回 null */
export function replaceKsSegment(line: string, ordinal: number, newText: string): string | null {
  const hadCr = line.endsWith('\r');
  const body = hadCr ? line.slice(0, -1) : line;
  let idx = 0;
  for (const s of splitLine(body)) {
    if (s.type !== 'text') continue;
    if (idx !== ordinal) {
      idx++;
      continue;
    }
    const out = body.slice(0, s.start) + newText + body.slice(s.end);
    return hadCr ? out + '\r' : out;
  }
  return null;
}
