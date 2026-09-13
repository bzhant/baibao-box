import { promises as fs } from 'node:fs';
import { lz4DecompressBlock, Lz4Error } from './lz4';

/**
 * UnityFS（AssetBundle）容器解析。
 *
 * 目的：把打包/压缩的 Unity 资源**还原成原始字节**，为后续的文本抽取铺路
 * （Unity 6 的 bundle 基本都是 LZ4HC 压缩的 UnityFS v8）。
 *
 * 结构：
 *   header: signature "UnityFS\0", u32 version, cstr unityVersion, cstr unityRevision,
 *           i64 fileSize, u32 compressedBlocksInfoSize, u32 uncompressedBlocksInfoSize, u32 flags
 *   flags:  低 6 位 = 压缩方式(0无/1 LZMA/2 LZ4/3 LZ4HC)，0x80 = 块信息在文件末尾
 *   blocksInfo(压缩): [16B hash][u32 blockCount][块(u32 未压,u32 已压,u16 flag)…]
 *                     [u32 nodeCount][目录项(i64 offset,i64 size,u32 flags,cstr name)…]
 *   data:   按块表拼接（每块按容器压缩方式解压）
 */

// ★ 同 serialized.ts 的说明：不用 `const enum`，改用常量对象 ——
//   `const enum` 在 node 的 strip-only TypeScript 模式下报
//   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，会让 scripts/verify-*.ts 无法 import 本模块。
export const Compression = {
  None: 0,
  Lzma: 1,
  Lz4: 2,
  Lz4HC: 3,
} as const;
export type Compression = (typeof Compression)[keyof typeof Compression];

const COMP_NAME: Record<number, string> = {
  0: 'None',
  1: 'LZMA',
  2: 'LZ4',
  3: 'LZ4HC',
};

export interface UnityFsHeader {
  version: number;
  unityVersion: string;
  unityRevision: string;
  fileSize: number;
  compressedBlocksInfoSize: number;
  uncompressedBlocksInfoSize: number;
  flags: number;
  compression: Compression;
  blocksInfoAtEnd: boolean;
}

interface Block {
  uncompressedSize: number;
  compressedSize: number;
  flags: number;
}

export interface UnityFsEntry {
  name: string;
  offset: number;
  size: number;
  flags: number;
}

class Reader {
  // ★ 不用 TS 的"参数属性"写法：它在 node 的 strip-only TypeScript 模式下报
  //   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX，会让 scripts/verify-*.ts 无法 import 本模块。
  readonly b: Buffer;
  p: number;
  constructor(b: Buffer, p = 0) {
    this.b = b;
    this.p = p;
  }
  u8(): number {
    const v = this.b.readUInt8(this.p);
    this.p += 1;
    return v;
  }
  u16be(): number {
    const v = this.b.readUInt16BE(this.p);
    this.p += 2;
    return v;
  }
  u32be(): number {
    const v = this.b.readUInt32BE(this.p);
    this.p += 4;
    return v;
  }
  i64be(): number {
    const v = Number(this.b.readBigInt64BE(this.p));
    this.p += 8;
    return v;
  }
  cstr(): string {
    const idx = this.b.indexOf(0, this.p);
    const end = idx < 0 ? this.b.length : idx;
    const v = this.b.toString('latin1', this.p, end);
    this.p = end + 1;
    return v;
  }
}

export function isUnityFs(buf: Buffer): boolean {
  return buf.length >= 8 && buf.toString('latin1', 0, 7) === 'UnityFS';
}

/** 解析 UnityFS 头 */
export function parseUnityFsHeader(buf: Buffer): UnityFsHeader {
  if (!isUnityFs(buf)) throw new Lz4Error('不是 UnityFS 文件');
  const r = new Reader(buf, 7);
  r.u8(); // signature 结尾的 \0
  const version = r.u32be();
  const unityVersion = r.cstr();
  const unityRevision = r.cstr();
  const fileSize = r.i64be();
  const compressedBlocksInfoSize = r.u32be();
  const uncompressedBlocksInfoSize = r.u32be();
  const flags = r.u32be();
  return {
    version,
    unityVersion,
    unityRevision,
    fileSize,
    compressedBlocksInfoSize,
    uncompressedBlocksInfoSize,
    flags,
    compression: (flags & 0x3f) as Compression,
    blocksInfoAtEnd: (flags & 0x80) !== 0,
  };
}

/** 按容器压缩方式解压一块 */
function decompress(buf: Buffer, uncompressedSize: number, comp: Compression): Buffer {
  switch (comp) {
    case Compression.None:
      return buf;
    case Compression.Lz4:
    case Compression.Lz4HC:
      return lz4DecompressBlock(buf, uncompressedSize, 0);
    default:
      throw new Lz4Error(`暂不支持的压缩方式: ${COMP_NAME[comp] ?? comp}`);
  }
}

export interface UnityFsFile {
  header: UnityFsHeader;
  blocks: Block[];
  entries: UnityFsEntry[];
  /** 拼接并解压后的完整数据区 */
  data: Buffer;
}

/** 向上对齐到 16 字节 —— Unity 把块信息/数据段做了 16 字节对齐 */
function alignUp16(n: number): number {
  return (n + 15) & ~15;
}

/** 打开一个 UnityFS 包：解析块表、目录，并把数据区解压成连续字节 */
export function openUnityFs(buf: Buffer): UnityFsFile {
  const header = parseUnityFsHeader(buf);
  const comp = header.compression;

  // 1) 块信息（可能压缩）
  const headerEnd = (() => {
    const r = new Reader(buf, 7);
    r.u8(); r.u32be(); r.cstr(); r.cstr(); r.i64be(); r.u32be(); r.u32be(); r.u32be();
    return r.p;
  })();
  const infoOffset = header.blocksInfoAtEnd
    ? buf.length - header.compressedBlocksInfoSize
    : alignUp16(headerEnd);
  const rawInfo = buf.subarray(infoOffset, infoOffset + header.compressedBlocksInfoSize);
  const info = decompress(rawInfo, header.uncompressedBlocksInfoSize, comp);

  // 2) 解析块表 + 目录
  const ir = new Reader(info, 16); // 跳过 16 字节 hash
  const blockCount = ir.u32be();
  const blocks: Block[] = [];
  for (let i = 0; i < blockCount; i++) {
    const uncompressedSize = ir.u32be();
    const compressedSize = ir.u32be();
    const flags = ir.u16be();
    blocks.push({ uncompressedSize, compressedSize, flags });
  }
  const nodeCount = ir.u32be();
  const entries: UnityFsEntry[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const offset = ir.i64be();
    const size = ir.i64be();
    const flags = ir.u32be();
    const name = ir.cstr();
    entries.push({ name, offset, size, flags });
  }

  // 3) 解压数据块
  //    ⚠️ 块信息与数据块**都要 16 字节对齐**（Unity 6 实测）：
  //    块信息在 alignUp16(headerEnd)，数据块在 alignUp16(块信息结束)。
  //    少算这个对齐会解出乱码或直接报"匹配偏移非法"。
  const dataStart = header.blocksInfoAtEnd
    ? alignUp16(headerEnd)
    : alignUp16(infoOffset + header.compressedBlocksInfoSize);
  const parts: Buffer[] = [];
  let cursor = dataStart;
  for (const b of blocks) {
    const slice = buf.subarray(cursor, cursor + b.compressedSize);
    // 每个块**自带**压缩方式（flags 低 6 位）；容器级压缩只用于块信息。
    // 一直用容器压缩会在"块未压缩"的文件上解错。
    const blockComp = (b.flags & 0x3f) as Compression;
    parts.push(decompress(slice, b.uncompressedSize, blockComp));
    cursor += b.compressedSize;
  }
  const data = Buffer.concat(parts);

  return { header, blocks, entries, data };
}

/** 取出包内某个文件的字节 */
export function readEntry(file: UnityFsFile, name: string): Buffer | null {
  const e = file.entries.find((x) => x.name === name);
  if (!e) return null;
  return file.data.subarray(e.offset, e.offset + e.size);
}

/** 便捷：从磁盘打开 */
export async function openUnityFsFile(path: string): Promise<UnityFsFile> {
  return openUnityFs(await fs.readFile(path));
}
