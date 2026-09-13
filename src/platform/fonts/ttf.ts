/**
 * TTF / TTC 字体文件解析 —— 只为回答两个问题：
 *   1. **这个字体的真实 family 名是什么？**（写进游戏配置的必须是这个名字，猜文件名会匹配不上）
 *   2. **它收录了哪些字符？**（决定译文会不会变成豆腐块）
 *
 * 只实现必需的表：`name`（family 名）与 `cmap`（字符映射）。
 * 不引第三方库 —— 我们只需要读，不需要渲染。
 */

export interface FontFace {
  /** 字体真实 family 名，如 "SimHei"、"Microsoft YaHei" */
  family: string;
  /** 在 .ttc 里的索引（单文件为 0） */
  index: number;
  /** 覆盖的码点集合 */
  codepoints: Set<number>;
}

function readU16(b: Buffer, o: number) {
  return b.readUInt16BE(o);
}
function readU32(b: Buffer, o: number) {
  return b.readUInt32BE(o);
}

/** 找出字体文件里各个 face 的「表目录」偏移：单文件 1 个，.ttc 可能多个 */
function faceOffsets(buf: Buffer): number[] {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'ttcf') {
    const n = readU32(buf, 8);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const off = readU32(buf, 12 + i * 4);
      if (off + 12 <= buf.length) out.push(off);
    }
    return out.length ? out : [0];
  }
  return [0];
}

/** 取某张表的 [offset, length] */
function tableRange(buf: Buffer, faceOff: number, tag: string): [number, number] | null {
  const numTables = readU16(buf, faceOff + 4);
  const base = faceOff + 12;
  for (let i = 0; i < numTables; i++) {
    const rec = base + i * 16;
    if (rec + 16 > buf.length) return null;
    if (buf.toString('latin1', rec, rec + 4) === tag) {
      return [readU32(buf, rec + 8), readU32(buf, rec + 12)];
    }
  }
  return null;
}

/**
 * 解码 name 表里的一条字符串。
 *
 * ⚠️ 实测发现：规范说 platformID=3/0 用 **UTF-16 大端**，但**有些字体实际存成了小端**
 * （如 Arial / Cambria / Consolas 的 family 名）。只按大端解会得到 `䄀爀椀愀氀` 这种鬼东西，
 * 而我们要拿这个名字写进游戏配置 —— 写错就匹配不上字体。
 * 所以**两种字节序都解，取"更像字体名"的那个**。
 */
function decodeName(slice: Buffer, platformID: number): string {
  if (platformID === 1) return slice.toString('latin1'); // Mac Roman（ASCII 足够）
  if (slice.length % 2 !== 0) return slice.toString('latin1');

  const be = Buffer.from(slice).swap16().toString('utf16le');
  const le = slice.toString('utf16le');
  const score = (s: string): number => {
    let n = 0;
    for (const ch of s) {
      if (/\p{L}|\p{N}/u.test(ch)) n += 1;
      else if (ch === '\uFFFD' || ch.codePointAt(0)! < 0x20) n -= 50;
    }
    return n;
  };
  return score(be) >= score(le) ? be : le;
}

/** 读 `name` 表里的 family 名 */
export function readFamilyName(buf: Buffer, faceOff = 0): string {
  const range = tableRange(buf, faceOff, 'name');
  if (!range) return '';
  const [off, len] = range;
  if (off + 6 > buf.length) return '';
  const count = readU16(buf, off + 2);
  const stringOffset = off + readU16(buf, off + 4);

  let best = '';
  for (let i = 0; i < count; i++) {
    const rec = off + 6 + i * 12;
    if (rec + 12 > off + len) break;
    const platformID = readU16(buf, rec);
    const encodingID = readU16(buf, rec + 2);
    const nameID = readU16(buf, rec + 6);
    const length = readU16(buf, rec + 8);
    const strOff = readU16(buf, rec + 10);
    if (nameID !== 1 && nameID !== 16) continue; // 1=family, 16=typographic family
    const abs = stringOffset + strOff;
    if (abs + length > buf.length) continue;
    const slice = buf.subarray(abs, abs + length);
    const text = decodeName(slice, platformID);
    // 优先 Windows 平台的英文名，其次任意
    if (platformID === 3 && encodingID === 1 && nameID === 1) return text.trim();
    if (!best) best = text.trim();
  }
  return best;
}

/** 解析 cmap 子表，返回覆盖的码点集合 */
export function readCmap(buf: Buffer, faceOff = 0): Set<number> {
  const out = new Set<number>();
  const range = tableRange(buf, faceOff, 'cmap');
  if (!range) return out;
  const [off, len] = range;
  if (off + 4 > buf.length) return out;
  const numTables = readU16(buf, off + 2);

  // 优先选「Unicode 全码位」的子表（format 12），其次 BMP（format 4/6）
  const candidates: Array<{ off: number; rank: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const rec = off + 4 + i * 8;
    if (rec + 8 > off + len) break;
    const platformID = readU16(buf, rec);
    const encodingID = readU16(buf, rec + 2);
    const sub = off + readU32(buf, rec + 4);
    if (sub + 2 > buf.length) continue;
    const format = readU16(buf, sub);
    if (format !== 0 && format !== 4 && format !== 6 && format !== 12) continue;
    // rank 越小越优先；Windows 平台 + UCS-4 编码最优先
    let rank = 9;
    if (format === 12) rank = platformID === 3 ? (encodingID === 10 ? 0 : 1) : 2;
    else if (format === 4) rank = platformID === 3 ? (encodingID === 1 ? 3 : 4) : 5;
    else rank = 6;
    candidates.push({ off: sub, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank);

  for (const c of candidates) {
    collect(buf, c.off, out);
    if (out.size > 1000) break; // 已经够用（format 12 通常一次就够）
  }
  return out;
}

function collect(buf: Buffer, sub: number, out: Set<number>): void {
  const format = readU16(buf, sub);
  if (format === 4) {
    const segCountX2 = readU16(buf, sub + 6);
    const segCount = segCountX2 / 2;
    const endBase = sub + 14;
    const startBase = endBase + segCountX2 + 2;
    for (let i = 0; i < segCount; i++) {
      const end = readU16(buf, endBase + i * 2);
      const start = readU16(buf, startBase + i * 2);
      if (start === 0xffff) continue;
      for (let cp = start; cp <= end && cp - start < 0x10000; cp++) out.add(cp);
    }
  } else if (format === 6) {
    const first = readU16(buf, sub + 6);
    const count = readU16(buf, sub + 8);
    for (let i = 0; i < count; i++) out.add(first + i);
  } else if (format === 12) {
    const nGroups = readU32(buf, sub + 12);
    for (let i = 0; i < nGroups; i++) {
      const rec = sub + 16 + i * 12;
      if (rec + 12 > buf.length) break;
      const start = readU32(buf, rec);
      const end = readU32(buf, rec + 4);
      for (let cp = start; cp <= end; cp++) out.add(cp);
    }
  } else if (format === 0) {
    for (let i = 0; i < 256; i++) {
      if (buf[sub + 6 + i] !== 0) out.add(i);
    }
  }
}

/**
 * 解析一个字体文件里所有 face（.ttc 可能有多个）。
 * **只保留有 cmap 的 face** —— 没有字符映射的"脸"对我们没有意义，
 * 顺手让"拿非字体文件来解析"这种情况返回空数组而不是一个空壳。
 */
export function parseFontFile(buf: Buffer): FontFace[] {
  return faceOffsets(buf)
    .map((off, index) => ({
      family: readFamilyName(buf, off),
      index,
      codepoints: readCmap(buf, off),
    }))
    .filter((f) => f.codepoints.size > 0);
}

/** 文本里有哪些字符不在该字体覆盖范围内（忽略空白与控制符） */
export function missingChars(codepoints: ReadonlySet<number>, text: string): string[] {
  const missing = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x20 || cp === 0x7f) continue; // 空白/控制符不参与
    if (ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (!codepoints.has(cp)) missing.add(ch);
  }
  return [...missing];
}
