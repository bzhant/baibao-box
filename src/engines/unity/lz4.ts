/**
 * LZ4 **块**解压（UnityFS 用的就是标准 LZ4 block 格式）。
 *
 * 为什么自己写：Unity 的 AssetBundle 常用 LZ4/LZ4HC 压缩块，
 * 而 Node 内置的 zlib 不支持 LZ4。要静态读取 Unity 资源，这一步绕不过去。
 *
 * 块格式（每轮）：
 *   token: 高 4 位 = 字面量长度，低 4 位 = 匹配长度 - 4
 *   长度满 15 时继续读字节累加（255 表示还有）
 *   然后 2 字节小端 offset，从已解压区回抄（**允许重叠**）
 */

export class Lz4Error extends Error {}

/** 从 src[offset..] 解压出 dstSize 字节 */
export function lz4DecompressBlock(src: Buffer, dstSize: number, offset = 0): Buffer {
  if (dstSize < 0) throw new Lz4Error('目标长度非法');
  const out = Buffer.alloc(dstSize);
  if (dstSize === 0) return out;

  let ip = offset;
  let op = 0;
  const end = src.length;

  while (ip < end) {
    const token = src[ip++];

    // ── 字面量 ──
    let literalLen = token >> 4;
    if (literalLen === 15) {
      let b: number;
      do {
        if (ip >= end) throw new Lz4Error('字面量长度读取越界');
        b = src[ip++];
        literalLen += b;
      } while (b === 255);
    }
    if (op + literalLen > dstSize) throw new Lz4Error('字面量超出目标长度');
    if (ip + literalLen > end) throw new Lz4Error('字面量数据越界');
    src.copy(out, op, ip, ip + literalLen);
    ip += literalLen;
    op += literalLen;

    // 最后一段可以没有匹配
    if (op >= dstSize) break;
    if (ip >= end) break;

    // ── 匹配 ──
    if (ip + 2 > end) throw new Lz4Error('匹配偏移读取越界');
    const matchOffset = src.readUInt16LE(ip);
    ip += 2;
    if (matchOffset === 0 || matchOffset > op) throw new Lz4Error(`匹配偏移非法: ${matchOffset}`);

    let matchLen = token & 0x0f;
    if (matchLen === 15) {
      let b: number;
      do {
        if (ip >= end) throw new Lz4Error('匹配长度读取越界');
        b = src[ip++];
        matchLen += b;
      } while (b === 255);
    }
    matchLen += 4;
    if (op + matchLen > dstSize) throw new Lz4Error('匹配超出目标长度');

    // 逐字节回抄 —— 允许重叠（LZ4 的匹配可以引用尚未写完的字节）
    let ref = op - matchOffset;
    for (let i = 0; i < matchLen; i++) out[op++] = out[ref++];
  }

  if (op !== dstSize) throw new Lz4Error(`解压长度不符：得到 ${op}，期望 ${dstSize}`);
  return out;
}

/** 便捷：解压（自动把前 4 字节当作 uncompressedSize，Unity 有时这么存） */
export function lz4DecompressSized(src: Buffer): Buffer {
  const size = src.readUInt32LE(0);
  return lz4DecompressBlock(src, size, 4);
}
