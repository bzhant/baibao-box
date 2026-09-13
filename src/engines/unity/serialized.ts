import { openUnityFs, readEntry, type UnityFsFile } from './unityfs';

/**
 * Unity **SerializedFile** 解析。
 *
 * 这是 Unity 资源的核心容器：`.assets` / `globalgamemanagers` / bundle 内部的文件
 * 都是这个格式。要"可靠地"取出可译文本（而不是靠猜），必须解析它的
 * 头 → 元数据 → 类型树 → 对象表。
 *
 * ⚠️ **格式有两套**（实测得出，不是照抄文档）：
 *
 *  - **classic**（Unity ≤ 5.x 时代文档里的布局）：
 *      u32 metadataSize, u32 fileSize, u32 version, u32 dataOffset, u8 endianness, u8[3]
 *      元数据在 `fileSize - metadataSize` 处。
 *
 *  - **i64 变体**（Unity 6 / 实测版本 22）：头字段改成 **8 字节对齐的 i64**，
 *      i64 @0(保留), u32 version @8, i64 metadataSize @16, i64 fileSize @24,
 *      i64 dataOffset @32, u8 endianness @40, u8[7] 保留, **u8[8] 后元数据紧跟其后 @48**。
 *      实测样本：version=22, metadataSize=4809, fileSize=8628, dataOffset=4864(=align8(48+4809))
 *
 * 靠"能不能自洽校验"（fileSize 是否等于实际长度、metadataSize 是否合理）来选哪一套，
 * 两套都不自洽就明确报"未知变体"，**不硬猜**。
 */

/**
 * SerializedFile 头的两种变体。
 *
 * ★ 用 **普通常量对象 + 类型别名**，不用 `const enum`。
 *   原因：`const enum` 在 node 的 **strip-only TypeScript 模式**下会直接报
 *   `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，于是任何 `scripts/verify-*.ts`
 *   自测脚本（本项目约定用 `node --experimental-strip-types` 直跑）**都没法 import 这个模块**。
 *   值语义完全不变，只是换成能被 strip-types 处理的写法 —— 实测改完探针就能跑了。
 */
const Variant = {
  Classic: 'classic',
  I64: 'i64',
  Unknown: 'unknown',
} as const;
type Variant = (typeof Variant)[keyof typeof Variant];

export interface SerializedHeader {
  variant: Variant;
  version: number;
  metadataSize: number;
  fileSize: number;
  dataOffset: number;
  /** 0 = 小端（元数据按此字节序解析） */
  endianness: number;
  /** 头长度；元数据紧跟其后（i64 变体）*/
  headerSize: number;
  metadataOffset: number;
}

export interface TypeTreeNode {
  version: number;
  level: number;
  typeFlags: number;
  /** 类型名；若来自公共字符串表且未内置该表，则为空串 */
  type: string;
  /** 字段名；同上 */
  name: string;
  /**
   * 非 null 表示这个名字是 Unity 的**公共字符串**（内置类型/字段名），
   * 索引值存于此。公共字符串表是一张大常量表，尚未内置 —— 见文件头说明。
   * **不猜**：宁可留空并标出索引，也不要瞎填一个名字。
   */
  typeCommonIndex: number | null;
  nameCommonIndex: number | null;
  byteSize: number;
  index: number;
  metaFlag: number;
}

export interface SerializedType {
  classID: number;
  isStrippedType: boolean;
  scriptTypeIndex: number;
  /** 类型树（若构建时未剥离）；空数组表示被剥离 */
  nodes: TypeTreeNode[];
}

export interface ObjectInfo {
  pathID: number;
  byteStart: number;
  byteSize: number;
  typeID: number;
}

export interface SerializedFile {
  header: SerializedHeader;
  unityVersion: string;
  targetPlatform: number;
  enableTypeTree: boolean;
  types: SerializedType[];
  objects: ObjectInfo[];
  /**
   * 解析过程中遇到的问题。**宽松模式**：能解析多少就给多少，
   * 但把失败点如实记下来 —— 宁可少给数据，也不给错数据。
   */
  warnings: string[];
  /** 供上层取对象原始字节 */
  buffer: Buffer;
}

class Cursor {
  // ★ 显式声明字段 + 在构造函数里赋值，**不用 TS 的"参数属性"写法**
  //   （`constructor(public readonly b: Buffer)`）。
  //   原因同上面的 Variant：参数属性在 node 的 **strip-only TypeScript 模式**下
  //   报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，会让 `scripts/verify-*.ts`
  //   （本项目约定用 `node --experimental-strip-types` 直跑）**无法 import 本模块**。
  //   行为完全一致，只是换个写法。
  readonly b: Buffer;
  p: number;
  little: boolean;

  constructor(b: Buffer, p = 0, little = true) {
    this.b = b;
    this.p = p;
    this.little = little;
  }
  u8(): number {
    const v = this.b.readUInt8(this.p);
    this.p += 1;
    return v;
  }
  i16(): number {
    const v = this.little ? this.b.readInt16LE(this.p) : this.b.readInt16BE(this.p);
    this.p += 2;
    return v;
  }
  u16(): number {
    const v = this.little ? this.b.readUInt16LE(this.p) : this.b.readUInt16BE(this.p);
    this.p += 2;
    return v;
  }
  i32(): number {
    const v = this.little ? this.b.readInt32LE(this.p) : this.b.readInt32BE(this.p);
    this.p += 4;
    return v;
  }
  i64(): number {
    const v = this.little ? this.b.readBigInt64LE(this.p) : this.b.readBigInt64BE(this.p);
    this.p += 8;
    return Number(v);
  }
  cstr(): string {
    const idx = this.b.indexOf(0, this.p);
    const end = idx < 0 ? this.b.length : idx;
    const s = this.b.toString('utf8', this.p, end);
    this.p = end + 1;
    return s;
  }
  align(n: number): void {
    const rem = this.p % n;
    if (rem !== 0) this.p += n - rem;
  }
}

/** 判断用哪套头布局：以"能自洽校验"为准 */
export function parseSerializedHeader(buf: Buffer): SerializedHeader {
  // 试 classic
  if (buf.length >= 20) {
    const metadataSize = buf.readUInt32BE(0);
    const fileSize = buf.readUInt32BE(4);
    const version = buf.readUInt32BE(8);
    const dataOffset = buf.readUInt32BE(12);
    const endianness = buf.readUInt8(16);
    if (
      fileSize === buf.length &&
      metadataSize > 0 &&
      metadataSize < buf.length &&
      version > 0 &&
      dataOffset < buf.length
    ) {
      return {
        variant: Variant.Classic,
        version,
        metadataSize,
        fileSize,
        dataOffset,
        endianness,
        headerSize: 20,
        metadataOffset: buf.length - metadataSize,
      };
    }
  }

  // 试 i64 变体（Unity 6）
  if (buf.length >= 48) {
    const version = buf.readUInt32BE(8);
    const metadataSize = Number(buf.readBigInt64BE(16));
    const fileSize = Number(buf.readBigInt64BE(24));
    const dataOffset = Number(buf.readBigInt64BE(32));
    const endianness = buf.readUInt8(40);
    const headerSize = 48;
    if (
      fileSize === buf.length &&
      metadataSize > 0 &&
      headerSize + metadataSize <= buf.length &&
      version > 0
    ) {
      return {
        variant: Variant.I64,
        version,
        metadataSize,
        fileSize,
        dataOffset,
        endianness,
        headerSize,
        metadataOffset: headerSize, // 元数据紧跟 48 字节头
      };
    }
  }

  return {
    variant: Variant.Unknown,
    version: buf.length >= 12 ? buf.readUInt32BE(8) : 0,
    metadataSize: 0,
    fileSize: buf.length,
    dataOffset: 0,
    endianness: 0,
    headerSize: 0,
    metadataOffset: 0,
  };
}

/** 解析类型树（节点表 + 字符串缓冲区） */
function parseTypeTree(c: Cursor, version: number): TypeTreeNode[] {
  const nodeCount = c.i32();
  const stringBufferSize = c.i32();
  if (nodeCount < 0 || nodeCount > 100_000 || stringBufferSize < 0 || stringBufferSize > 10_000_000) {
    throw new Error(`类型树规模异常: nodes=${nodeCount} strings=${stringBufferSize}`);
  }
  interface RawNode {
    version: number;
    level: number;
    typeFlags: number;
    byteSize: number;
    index: number;
    metaFlag: number;
    typeOff: number;
    nameOff: number;
  }
  const raw: RawNode[] = [];
  for (let i = 0; i < nodeCount; i++) {
    const v = c.u16();
    const level = c.u8();
    const typeFlags = c.u8();
    const typeOff = c.i32();
    const nameOff = c.i32();
    const byteSize = c.i32();
    const index = c.i32();
    const metaFlag = c.i32();
    if (version >= 19) c.i64(); // refTypeHash
    raw.push({ version: v, level, typeFlags, byteSize, index, metaFlag, typeOff, nameOff });
  }
  const sbStart = c.p;
  /**
   * 取字符串。⚠️ Unity 的类型树有两种字符串来源（实测确认）：
   *   - 偏移**高位为 0** → 本地字符串缓冲区里的偏移；
   *   - 偏移**高位为 1** → Unity 内置的**公共字符串表**索引（内置类型/字段名）。
   * 我们只内置了本地缓冲区；公共字符串表是一张大常量表，尚未引入，
   * 因此返回空串并把索引记下来（**不猜名字**）。
   */
  const strAt = (off: number): { text: string; commonIndex: number | null } => {
    if ((off & 0x80000000) !== 0) return { text: '', commonIndex: off & 0x7fffffff };
    if (off >= stringBufferSize) return { text: '', commonIndex: null };
    const idx = c.b.indexOf(0, sbStart + off);
    const end = idx < 0 ? sbStart + stringBufferSize : idx;
    return { text: c.b.toString('utf8', sbStart + off, end), commonIndex: null };
  };
  const nodes: TypeTreeNode[] = raw.map((r) => {
    const t = strAt(r.typeOff);
    const n = strAt(r.nameOff);
    return {
      version: r.version,
      level: r.level,
      typeFlags: r.typeFlags,
      byteSize: r.byteSize,
      index: r.index,
      metaFlag: r.metaFlag,
      type: t.text,
      name: n.text,
      typeCommonIndex: t.commonIndex,
      nameCommonIndex: n.commonIndex,
    };
  });
  c.p = sbStart + stringBufferSize;
  return nodes;
}

/**
 * 判断某偏移处是否"像一个类型条目"。
 *
 * 用途：**类型树的字符串缓冲区声明长度与实测边界可能差几字节**
 * （实测 Unity 6 样本差了 5 字节）。与其硬编码这个偏移，不如用结构校验：
 * 下一个类型条目应当 classID 合理、stripped ∈{0,1}、scriptTypeIndex 合理、
 * 且类型树的 nodeCount/stringBufferSize 在合理区间。在有限窗口内搜到第一个自洽的位置。
 */
function looksLikeTypeEntry(buf: Buffer, p: number, little: boolean, hasTree: boolean): boolean {
  if (p + 31 > buf.length) return false;
  const rd32 = (o: number) => (little ? buf.readInt32LE(o) : buf.readInt32BE(o));
  const classID = rd32(p);
  const stripped = buf[p + 4];
  const sti = little ? buf.readInt16LE(p + 5) : buf.readInt16BE(p + 5);
  if (!(classID > 0 && classID < 300 && stripped <= 1 && sti >= -1 && sti < 100)) return false;
  if (!hasTree) return true;
  const nodeCount = rd32(p + 23);
  const sbs = rd32(p + 27);
  return nodeCount > 0 && nodeCount < 5000 && sbs > 0 && sbs < 50_000;
}

const TYPE_ENTRY_SEARCH = 64;

/** 解析完整 SerializedFile（头 + 元数据 + 类型 + 对象表） */
export function parseSerializedFile(buf: Buffer): SerializedFile {
  const header = parseSerializedHeader(buf);
  if (header.variant === Variant.Unknown) {
    throw new Error(`未知的 SerializedFile 头变体（version=${header.version}），拒绝猜测`);
  }
  const little = header.endianness === 0;
  const c = new Cursor(buf, header.metadataOffset, little);
  const version = header.version;

  const unityVersion = c.cstr();
  const targetPlatform = c.i32();
  const enableTypeTree = c.u8() !== 0;
  const typeCount = c.i32();

  const types: SerializedType[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < typeCount; i++) {
    try {
      const classID = c.i32();
      const isStrippedType = version >= 16 ? c.u8() !== 0 : false;
      const scriptTypeIndex = version >= 17 ? c.i16() : -1;
      if (version >= 13) c.p += 16; // scriptIDHash (Hash128)
      let nodes: TypeTreeNode[] = [];
      const hasTree = enableTypeTree && (version >= 12 || version === 10);
      if (hasTree) {
        nodes = parseTypeTree(c, version);
        // 字符串缓冲区声明长度与实测边界可能差几字节 → 结构性前向搜索下一个类型条目
        if (i < typeCount - 1) {
          for (let d = 0; d <= TYPE_ENTRY_SEARCH; d++) {
            if (looksLikeTypeEntry(buf, c.p + d, little, true)) {
              c.p += d;
              break;
            }
          }
        }
      }
      types.push({ classID, isStrippedType, scriptTypeIndex, nodes });
    } catch (err) {
      warnings.push(
        `类型 #${i} 解析失败（已解析 ${types.length}/${typeCount}）：${(err as Error).message}`,
      );
      break; // 后面依赖字节偏移，继续读只会产生错数据
    }
  }

  let objects: ObjectInfo[] = [];
  try {
    const objectCount = c.i32();
    if (objectCount < 0 || objectCount > 5_000_000) throw new Error(`对象数异常: ${objectCount}`);
    for (let i = 0; i < objectCount; i++) {
      c.align(4);
      const pathID = c.i64();
      const byteStart = c.i32();
      const byteSize = c.i32();
      const typeID = c.i32();
      objects.push({ pathID, byteStart, byteSize, typeID });
    }
  } catch (err) {
    warnings.push(`对象表解析失败，已置空：${(err as Error).message}`);
    objects = [];
  }

  return { header, unityVersion, targetPlatform, enableTypeTree, types, objects, warnings, buffer: buf };
}

/** 取对象的原始字节 */
export function objectBytes(sf: SerializedFile, o: ObjectInfo): Buffer {
  return sf.buffer.subarray(o.byteStart, o.byteStart + o.byteSize);
}

/** 概览（日志/诊断用，不碰数据） */
export function describeSerialized(sf: SerializedFile): string {
  const names = sf.types.map((t) => t.nodes[0]?.type || `classID=${t.classID}`);
  const commonCount = sf.types.flatMap((t) => t.nodes).filter((n) => n.nameCommonIndex !== null || n.typeCommonIndex !== null).length;
  return (
    `SerializedFile ${sf.header.variant} v${sf.header.version} unity=${sf.unityVersion} ` +
    `types=[${names.join(', ')}] objects=${sf.objects.length} ` +
    `typeTree=${sf.enableTypeTree ? '有' : '被剥离'}` +
    (commonCount ? ` 公共字符串引用=${commonCount}(未内置表，按索引保留)` : '')
  );
}

/** 从 UnityFS 包里取第一个 SerializedFile 并解析 */
export function serializedFromBundleBuffer(buf: Buffer): SerializedFile {
  const f: UnityFsFile = openUnityFs(buf);
  const e = f.entries[0];
  if (!e) throw new Error('包内没有文件');
  const inner = readEntry(f, e.name) ?? f.data;
  return parseSerializedFile(inner);
};
