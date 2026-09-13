/**
 * shellcode 提取器 —— 从 shellcode_stub.cpp 编译出的 COFF .obj 里，
 * 把"要拷进目标进程的裸机器码"精确地抠出来，导出成 C++ 头文件。
 *
 * ============================================================================
 * 为什么走 .obj 解析，而不是"自定义段 + 链接器 start/stop 符号"：
 *   · 那种做法依赖 /INCREMENTAL:NO、段顺序、链接 stub，脆弱且难调试；
 *   · 一旦编译器把某个工具函数重排到别的段，我们就会**少拷一段代码**，
 *     在目标进程里表现为随机崩溃 —— 这类 bug 极难定位。
 *  用 .obj 解析的确定性要好得多：每个节多大、每条重定位指向谁，都明明白白。
 *
 * ============================================================================
 * 【实测出来的 .obj 结构】（MSVC 14.44，/O2 /GS- /Gy- /Zl）
 *
 * 一个 shellcode 编译单元会产生**多个 `.text$mn` 节**（$mn = 名字排序，
 * 链接器会把同前缀节合并），每个函数一个，外加若干 `.rdata` 存字符串字面量。
 * 所以我们不能"取一个 .text 节"，必须：
 *
 *   ① 迭代求闭包：从入口符号（ShellcodeMain）出发，沿 `.text` 节 → 节的重定位，
 *      反复加入"被 text 节引用的 text 节"，直到不动点。这与链接器的行为一致。
 *   ② 把这些节**按链接顺序拼接**成一块连续的代码镜像。链接器对同一"节组"
 *      的处理是按节索引顺序（已在 verify-order.mjs 里**用真实链接产物的 MAP
 *      文件逐符号对拍验证过**：x86 / x64 上 7 个代码符号的偏移完全一致，
 *      见 `node native/shellcode/verify-order.mjs x86`）。
 *      这不是"应该一致"，是**被证明一致**。
 *   ③ 记录每个符号在新镜像中的偏移，生成一张"符号 → 偏移"表写进头文件。
 *   ④ 对每条重定位分类：
 *        - **rel32**（跳转/调用，含 x64 上绝大多数 RIP 相对引用）：
 *          源与目标都在镜像里 → 整体平移距离不变 → **不需要任何修正**。
 *          这就是"位置无关"的全部秘密：只要代码内部只做相对引用，搬到哪都能跑。
 *        - **abs32 / abs64**（绝对地址；x86 上引用字符串字面量就是这种）：
 *          记录成"修正记录"，注入器按 `目标基址 + 镜像偏移` 重填。
 *        - **未定义符号**（导入函数）：**直接报错**，不允许出现。
 *  实测：x64 镜像 **0 处**修正（全 RIP 相对），x86 镜像 **10 处**修正（全是 .rdata 字符串）。
 *  两者都能工作，且修正记录是自洽的（同时给出"写哪里"和"写什么"，不依赖链接器布局）。
 */

import fs from 'node:fs';

const SECTION_IMAGE_SCN_CNT_CODE = 0x00000020;
const REL_I386_DIR32 = 0x0006;
const REL_I386_REL32 = 0x0014;
const REL_AMD64_ADDR64 = 0x0001;
const REL_AMD64_ADDR32 = 0x0002;
const REL_AMD64_REL32 = 0x0004;
const REL_AMD64_REL32_1 = 0x0005;
const REL_AMD64_REL32_2 = 0x0006;
const REL_AMD64_REL32_3 = 0x0007;
const REL_AMD64_REL32_4 = 0x0008;
const REL_AMD64_REL32_5 = 0x0009;
const REL_AMD64_SECREL = 0x000B;
const REL_AMD64_SECTION = 0x000A;

/**
 * REL32 家族的类型码 → 尾部补偿字节数 N。
 *
 * ★ 为什么需要 N（这是 x64 上的一个真实陷阱）：
 *   x86 的 `REL32`（0x14）只有一种：字段位置就是"下一条指令"的起点，
 *   `值 = 目标 - (字段位置 + 4)`。
 *   x64 上 MSVC 会把"相对下一条指令"拆成 6 种，区别是字段与指令末尾之间
 *   还夹着 0~5 个字节（典型场景：`mov dword ptr [rip+disp32], imm8`
 *   里 disp32 后面还跟着一个 imm8）：
 *       REL32   (0x04) N=0
 *       REL32_1 (0x05) N=1
 *       REL32_2 (0x06) N=2
 *       REL32_3 (0x07) N=3
 *       REL32_4 (0x08) N=4
 *       REL32_5 (0x09) N=5
 *   正确公式：`值 = 目标 - (字段位置 + 4 + N)`。
 *   本项目的 shellcode 实测只出现 N=0；但**留着这张表**，
 *   因为一旦将来某个函数序言变了、冒出 `REL32_1`，用错 N 会得到
 *   "差了 1 字节的地址"——那种错误在目标进程里表现成随机乱跳，极难查。
 */
const REL32_TAIL_BYTES = new Map([
  [REL_AMD64_REL32, 0],
  [REL_AMD64_REL32_1, 1],
  [REL_AMD64_REL32_2, 2],
  [REL_AMD64_REL32_3, 3],
  [REL_AMD64_REL32_4, 4],
  [REL_AMD64_REL32_5, 5],
]);

/** 解析 COFF .obj 的节表 + 符号表 */
export function parseCoff(buf) {
  const u16 = (o) => buf.readUInt16LE(o);
  const u32 = (o) => buf.readUInt32LE(o);

  const machine = u16(0);
  const numSections = u16(2);
  const symTabPtr = u32(8);
  const numSymbols = u32(12);
  const optHeaderSize = u16(16);
  const strBase = symTabPtr + numSymbols * 18;

  const readName = (o) => {
    const raw = buf.subarray(o, o + 8);
    if (raw.readUInt32LE(0) === 0) {
      const so = strBase + raw.readUInt32LE(4);
      return buf.subarray(so, buf.indexOf(0, so)).toString('latin1');
    }
    return raw.toString('latin1').replace(/\0+$/, '');
  };

  const sections = [];
  let off = 20 + optHeaderSize;
  for (let i = 0; i < numSections; i++) {
    sections.push({
      name: readName(off),
      virtualSize: u32(off + 8),
      virtualAddress: u32(off + 12),
      rawSize: u32(off + 16),
      rawPtr: u32(off + 20),
      relocPtr: u32(off + 24),
      relocOverflowPtr: u32(off + 28),
      numReloc: u16(off + 32),
      numLine: u16(off + 34),
      characteristics: u32(off + 36),
      index: i + 1,
    });
    off += 40;
  }

  const symbols = [];
  for (let i = 0; i < numSymbols; i++) {
    const o = symTabPtr + i * 18;
    symbols.push({
      name: readName(o),
      value: u32(o + 8),
      sectionNumber: buf.readInt16LE(o + 12),
      type: u16(o + 14),
      storageClass: buf.readUInt8(o + 16),
      numAux: buf.readUInt8(o + 17),
      index: i,
    });
  }

  const relocations = (sec) => {
    const out = [];
    for (let i = 0; i < sec.numReloc; i++) {
      const o = sec.relocPtr + i * 10;
      out.push({
        virtualAddress: u32(o),
        symbolIndex: u32(o + 4),
        type: u16(o + 8),
      });
    }
    return out;
  };

  return { machine, sections, symbols, relocations };
}

/** 该符号是不是一条"数据"符号（不在任何代码节里） */
function symbolSection(coff, symIndex) {
  const s = coff.symbols[symIndex];
  if (!s || s.sectionNumber <= 0) return null;
  return coff.sections[s.sectionNumber - 1] ?? null;
}

function isCodeSection(sec) {
  return /^\.text/.test(sec.name);
}

const IMAGE_SCN_CNT_UNINITIALIZED_DATA = 0x00000080;
const IMAGE_SCN_CNT_INITIALIZED_DATA = 0x00000040;

/**
 * 这一节在 .obj 文件里**到底有没有实体字节**？
 *
 * ★★ 不能只看 `rawSize > 0` —— 这是一个实测踩到的坑，而且很隐蔽 ★★
 *
 * MSVC 给 `.bss` 的节头长这样（本仓库实测的原始值）：
 *
 *     .bss   rawSize=8   rawPtr=0   characteristics=0xC0300080
 *                           ↑           ↑
 *                     文件偏移是 0    带 CNT_UNINITIALIZED_DATA
 *
 * 也就是说 `rawSize` 非 0，但 `rawPtr` 是 0（"没有实体数据"的节在 COFF 里
 * 把 PointerToRawData 写成 0）。如果按 `rawSize > 0` 就 `buf.subarray(rawPtr, rawPtr+rawSize)`，
 * 那就等于 `buf.subarray(0, 8)` —— **读到文件最开头的 COFF 文件头**：
 *
 *     Machine(0x014C=4c 01) + NumberOfSections(1d 00) + TimeDateStamp(4 字节)
 *
 * 后果有两个：
 *   ① `.bss` 里本该为 0 的变量被填上了**编译器时间戳** —— 每次重新编译
 *      生成的镜像都不同（构建不可复现，git 里每次都是脏的）
 *   ② 万一将来有别的 `.bss` 变量真依赖"初值为 0"，那就是一个静默的错值
 *
 * （本轮实测：镜像里 0x760/0x770/0x780 三个槽都是 `4c 01 1d 00` + 同一个
 *   2026-09 的时间戳，正是 .obj 的 COFF 头。）
 *
 * 正确判据：**有实体字节 = rawSize>0 且 rawPtr>0 且 不是"未初始化数据"节**。
 */
function hasFileBytes(sec) {
  return (
    sec.rawSize > 0 &&
    sec.rawPtr > 0 &&
    (sec.characteristics & IMAGE_SCN_CNT_UNINITIALIZED_DATA) === 0
  );
}

/**
 * 判断一个节是否属于"要一起搬进镜像的数据"。
 *
 * ⚠️ 必须把 `.bss` 也算上 —— 这是一个实测踩到的坑：
 *    我们有两个**自举用的全局变量**（`g_selfImageBase` / `g_bootCtxSlot`），
 *    它们初值都是 0。MSVC 对"初值为 0 的全局变量"不会放进 `.data`，
 *    而是放进 **`.bss`**（未初始化数据节，在文件里不占空间）。
 *    如果这里只匹配 `.rdata`/`.data`，那两个符号就会被判为"所在节不在镜像里"
 *    直接报错（实测错误：`引用的符号 _g_selfImageBase 所在节不在镜像里`）。
 *
 *    `.bss` 的字节在 .obj 里**没有实体内容**（rawSize 通常是 0），
 *    但没关系：我们只要**在镜像里给它留出位置**（全 0 即可），
 *    注入器后面会往槽里写 ctx 指针，所以槽的初值是什么根本不重要。
 *    见下面组装数据节时对"rawSize 为 0 的节"的处理。
 */
function isDataSection(sec) {
  return /^\.rdata/.test(sec.name) || /^\.data/.test(sec.name) || /^\.bss/.test(sec.name);
}

/**
 * ★ 核心：把"从入口可达的全部代码 + 它引用的数据"组装成一个连续镜像。
 *
 * @param objPath           shellcode_stub.obj
 * @param entryNames        入口符号名（extern "C"，可能带前导下划线）
 * @param opts.arch         'x86' | 'x64'，用于判定哪些重定位是可以接受的
 */
export function extractShellcode(objPath, entryNames, opts = {}) {
  const buf = fs.readFileSync(objPath);
  const coff = parseCoff(buf);
  const arch = opts.arch ?? (coff.machine === 0x8664 ? 'x64' : 'x86');

  // ── 1) 找入口符号 ──
  const norm = (n) => n.replace(/^_+/, '');
  const entry = coff.symbols.find(
    (s) => s.sectionNumber > 0 && entryNames.some((n) => norm(s.name) === n || s.name === n),
  );
  if (!entry) {
    const cands = coff.symbols
      .filter((s) => s.sectionNumber > 0 && s.storageClass === 2)
      .map((s) => s.name);
    throw new Error(
      `在 .obj 里找不到入口符号 ${entryNames.join(' / ')}。可用的外部符号：${cands.join(', ')}`,
    );
  }
  const entrySec = coff.sections[entry.sectionNumber - 1];

  // ── 2) 迭代求代码节闭包 ──
  //
  // 可达性规则：
  //   · 入口节必含
  //   · 某代码节里的重定位指向的**另一个代码节** → 也含
  //   反复迭代到不动点。
  //
  // 为什么按"节"而不是按"函数"：/Gy- 关掉了函数级 COMDAT，
  // 每个函数独占一个 .text$mn 节，所以"节"就等于"函数"，粒度正好。
  const codeSections = coff.sections.filter(isCodeSection);
  const reachable = new Set([entrySec.index]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sec of codeSections) {
      if (!reachable.has(sec.index)) continue;
      for (const rel of coff.relocations(sec)) {
        const target = symbolSection(coff, rel.symbolIndex);
        if (target && isCodeSection(target) && !reachable.has(target.index)) {
          reachable.add(target.index);
          changed = true;
        }
      }
    }
  }

  // ── 3) 拼接代码镜像 ──
  //
  // 顺序：按节索引升序。实测这正是链接器合并 .text$mn 组时的顺序
  // （MSVC 按节名后缀排序，而每个函数节的后缀与索引顺序一致）。
  // build.mjs 里会用**真实链接产物**对拍验证这一点，不靠"应该"。
  const ordered = codeSections
    .filter((s) => reachable.has(s.index))
    .sort((a, b) => a.index - b.index);

  const codeChunks = [];
  const symbolImageOffset = new Map(); // 符号索引 → 镜像内偏移
  let cursor = 0;

  // 3a) 先固定代码节的位置，并给每个节内符号记偏移
  const secImageBase = new Map();
  for (const sec of ordered) {
    // 16 字节对齐：让每个函数起始处对齐，便于 64 位 RIP 相对编码稳定
    if (cursor % 16 !== 0) cursor += 16 - (cursor % 16);
    secImageBase.set(sec.index, cursor);
    // 代码节一定带实体字节；仍走 hasFileBytes 以免将来判错时读到文件头
    const codeBody = hasFileBytes(sec)
      ? buf.subarray(sec.rawPtr, sec.rawPtr + sec.rawSize)
      : Buffer.alloc(sec.rawSize);
    codeChunks.push({ sec, at: cursor, bytes: codeBody });
    cursor += sec.rawSize;
  }
  for (const sym of coff.symbols) {
    if (sym.sectionNumber <= 0) continue;
    const base = secImageBase.get(sym.sectionNumber);
    if (base === undefined) continue;
    symbolImageOffset.set(sym.index, base + sym.value);
  }

  // ── 4) 收集数据节（字符串字面量），并给数据符号也分配镜像偏移 ──
  //
  // 数据节按"被引用的顺序"追加在代码之后，16 字节对齐。
  const dataSecMap = new Map(); // 原节索引 → 镜像偏移
  const dataChunks = [];
  const referencedData = [];
  for (const sec of ordered) {
    for (const rel of coff.relocations(sec)) {
      if (rel.type === REL_AMD64_SECTION || rel.type === REL_AMD64_SECREL) continue;
      const target = symbolSection(coff, rel.symbolIndex);
      if (target && isDataSection(target) && !dataSecMap.has(target.index)) {
        referencedData.push(target);
      }
    }
  }
  for (const sec of referencedData) {
    if (cursor % 16 !== 0) cursor += 16 - (cursor % 16);
    dataSecMap.set(sec.index, cursor);
    // 数据节里的符号也要记账（编译器常把同一节里的字符串拆成多个符号）
    //
    // ⚠️ `.bss`（未初始化数据）在 .obj 里**没有实体字节** —— 但**必须占位**，
    //    否则后面的符号偏移全乱（甚至两个符号叠在同一地址）。
    //    所以按"这一节里所有符号的 size 之和"给它留出空间（向上对齐到 16）。
    //    留出来的字节天然是 0（Buffer.alloc 默认清零），正好对应 .bss 的语义。
    //
    //    ★ 判据用 hasFileBytes() 而**不是** `rawSize > 0` ——
    //      MSVC 给 .bss 的 rawSize 非 0 而 rawPtr 是 0，
    //      按 rawSize 判断会读到 .obj 的 COFF 文件头（含编译器时间戳）。
    //      详见 hasFileBytes() 的注释。
    let size = sec.rawSize;
    if (!hasFileBytes(sec)) {
      let maxEnd = 0;
      for (const sym of coff.symbols) {
        if (sym.sectionNumber !== sec.index) continue;
        const end = sym.value + (sym.size ?? 0);
        if (end > maxEnd) maxEnd = end;
      }
      size = maxEnd;
      if (size === 0) size = 16;   // 兜底：至少留一点，避免后续偏移重叠
      if (size % 16 !== 0) size += 16 - (size % 16);
    }
    const body = hasFileBytes(sec)
      ? buf.subarray(sec.rawPtr, sec.rawPtr + sec.rawSize)
      : Buffer.alloc(size);      // .bss：实体为零字节
    dataChunks.push({ sec, at: cursor, bytes: body, size });
    cursor += size;
  }
  for (const sym of coff.symbols) {
    if (sym.sectionNumber <= 0) continue;
    const base = dataSecMap.get(sym.sectionNumber);
    if (base === undefined) continue;
    symbolImageOffset.set(sym.index, base + sym.value);
  }

  // ── 5) 逐条检查重定位，分类 ──
  //
  // 分类结果：
  //   · safe-intra : 相对跳转/调用，**源与目标都在镜像内**，且镜像装进目标后
  //                  两者距离不变 → **不需要任何修正**（这是位置无关的关键）
  //   · data-ref   : 指向数据（字符串字面量）。x64 是 RIP 相对，也是"距离不变"！
  //                  x86 是绝对地址（DIR32）→ **必须修正**
  //   · unsafe-abs : 64 位绝对地址（ADDR64）→ 必须修正（我们要求 shellcode 不产生它）
  //   · external   : 指向未定义符号（导入函数）→ 绝不允许
  const fixes = [];
  const problems = [];

  const relSizeAndKind = (type) => {
    switch (type) {
      case REL_I386_DIR32:
        return { size: 4, kind: 'abs32' };
      case REL_I386_REL32:
        return { size: 4, kind: 'rel32', tail: 0 };
      case REL_AMD64_ADDR64:
        return { size: 8, kind: 'abs64' };
      case REL_AMD64_ADDR32:
        return { size: 4, kind: 'abs32' };
      case REL_AMD64_REL32:
      case REL_AMD64_REL32_1:
      case REL_AMD64_REL32_2:
      case REL_AMD64_REL32_3:
      case REL_AMD64_REL32_4:
      case REL_AMD64_REL32_5:
        return { size: 4, kind: 'rel32', tail: REL32_TAIL_BYTES.get(type) ?? 0 };
      case REL_AMD64_SECTION:
      case REL_AMD64_SECREL:
        return { size: 2, kind: 'section-meta' };
      default:
        return { size: 0, kind: 'unknown' };
    }
  };

  for (const sec of ordered) {
    const base = secImageBase.get(sec.index);
    for (const rel of coff.relocations(sec)) {
      const info = relSizeAndKind(rel.type);
      const where = base + rel.virtualAddress;
      const sym = coff.symbols[rel.symbolIndex];

      if (sym.sectionNumber === 0) {
        problems.push(
          `镜像偏移 0x${where.toString(16)} 引用了未定义符号 ${sym.name}` +
            `（shellcode 不能调用任何导入函数，必须自己从 PEB 找 API）`,
        );
        continue;
      }
      if (info.kind === 'section-meta') continue; // .voltbl 之类，链接器自己处理

      const target = symbolSection(coff, rel.symbolIndex);
      const targetOff = symbolImageOffset.get(rel.symbolIndex);
      if (targetOff === undefined) {
        problems.push(
          `镜像偏移 0x${where.toString(16)} 引用的符号 ${sym.name} 所在节不在镜像里`,
        );
        continue;
      }

      if (info.kind === 'rel32') {
        // ★★ 相对引用的修正 —— 本项目最容易想岔的一处，值得完整说明 ★★
        //
        // 曾经的错误推理（导致目标进程 0xC0000005）：
        //   "rel32 是相对的，源和目标都在镜像里，整体平移距离不变，
        //    所以不需要任何修正。" —— 前半句对，结论错。
        //
        // 真正的情况：**这个前提只有在"代码被链接器处理过"之后才成立。**
        //   在 COFF .obj 里，节与节之间的重定位**根本没有被解析** ——
        //   汇编器看不到别的节在哪，只能把 rel32 写成**占位 0**，
        //   并挂一条重定位记录，等**链接器**来填真实距离。
        //   我们跳过链接器直接拼镜像，就必须自己扮演链接器。
        //
        // 后果（实测）：入口第一条 `call TakeCtxFromBootSlot` 是 `e8 00000000`，
        //   即"调用下一条指令"—— 函数压根没被调到。于是 esi（返回值）里是
        //   栈上残留的垃圾，非 0，代码误判"ctx 有效"继续往下走，
        //   读 `[esi+0x270]` 当场访问冲突。
        //
        // 公式：`值 = 目标镜像偏移 - (字段镜像偏移 + 4 + tail)`
        //   · +4 是因为 rel32 字段本身占 4 字节，CPU 计算时基准是"下一条指令"
        //   · +tail 是 x64 上 REL32_k 家族的额外尾随字节（见 REL32_TAIL_BYTES）
        //
        // 为什么算出来能直接用：注入器把整个镜像搬到目标进程的**一块连续内存**里，
        //   **镜像内的相对距离原样保留** —— 所以这个在"镜像坐标系"下算出的
        //   相对值，搬到目标进程后依然正确。这正是"位置无关"能成立的原因，
        //   也是为什么 rel32 修正**不需要**注入器在运行时参与（而 abs32/abs64 需要）。
        const value = (targetOff - (where + 4 + (info.tail ?? 0))) | 0;
        fixes.push({
          at: where,
          size: 4,
          targetImageOffset: targetOff,
          kind: 'rel32',
          value,
          what: `${sym.name}（${target?.name ?? '?'} 节，相对引用）`,
        });
        continue;
      }
      if (info.kind === 'abs32' || info.kind === 'abs64') {
        // 绝对地址 → 必须由注入器按"目标基址 + 镜像偏移"重填
        fixes.push({
          at: where,
          size: info.size,
          targetImageOffset: targetOff,
          what: `${sym.name}（${target?.name ?? '?'} 节）`,
        });
        continue;
      }
      problems.push(`镜像偏移 0x${where.toString(16)} 有未知重定位类型 0x${rel.type.toString(16)}`);
    }
  }

  if (problems.length) {
    throw new Error(
      `shellcode 不能做成位置无关镜像，发现 ${problems.length} 处问题：\n  - ` +
        problems.join('\n  - '),
    );
  }

  // ── 6) 组装字节 ──
  //    ⚠️ 用 c.size 而不是 c.sec.rawSize —— 对 `.bss` 我们额外留了空间
  const image = Buffer.alloc(cursor);
  for (const c of [...codeChunks, ...dataChunks]) {
    c.bytes.copy(image, c.at);
  }

  // ── 6b) 就地应用 rel32 修正（构建期就能定值，不需要注入器参与）──
  //
  //   这一步把"我们自己当链接器"这件事做完：把 .obj 里所有占位 0 的
  //   相对引用改成"目标镜像偏移 - 源位置"的真实距离。
  //   之后剩下的 fixes 里就只有 abs32/abs64（需要注入器按实际基址填）
  //   和尾部跳板占位了。
  let rel32Applied = 0;
  for (const f of fixes) {
    if (f.kind !== 'rel32') continue;
    image.writeInt32LE(f.value | 0, f.at);
    rel32Applied++;
  }

  // ── 7) 符号表（写进头文件，注入器用它做绝对地址修正 + 打日志）──
  const symbolTable = [];
  for (const [symIdx, off] of symbolImageOffset) {
    const sym = coff.symbols[symIdx];
    if (sym.storageClass !== 2) continue; // 只保留外部（可链接）符号
    symbolTable.push({ name: sym.name, offset: off });
  }
  symbolTable.sort((a, b) => a.offset - b.offset);

  // ── 8) 自举槽（boot slot）─────────────────────────────────────────────────
  //
  // shellcode 通过 `g_bootCtxSlot` 这个全局变量自己找到 ctx 指针，
  // **不依赖任何参数传递约定**（OEP 模式下没法压栈/摆寄存器，详见
  // shellcode_stub.cpp 里 g_selfImageBase 的说明）。
  //
  // 注入器需要知道这个槽在**镜像里的偏移**才能把 ctx 值写进去，所以
  // 这里把它从符号表里捞出来单独导出。
  const BOOT_SLOT_SYM = 'g_bootCtxSlot';
  const SELF_BASE_SYM = 'g_selfImageBase';

  let bootSlotOffset = null;
  let selfBaseOffset = null;
  for (const [symIdx, off] of symbolImageOffset) {
    const nm = coff.symbols[symIdx].name;
    // COFF 里 C 符号可能带前导下划线（x86）：`_g_bootCtxSlot`
    const bare = nm.replace(/^_+/, '');
    if (bare === BOOT_SLOT_SYM) bootSlotOffset = off;
    if (bare === SELF_BASE_SYM) selfBaseOffset = off;
  }
  if (bootSlotOffset === null) {
    throw new Error(
      `镜像里找不到自举槽符号 ${BOOT_SLOT_SYM}。\n` +
        `  它是 shellcode 取 ctx 的唯一通道，缺了就完全没法启动 —— 请检查\n` +
        `  shellcode_stub.cpp 里该变量是否被优化掉了（必须带 __declspec(noinline) 且是全局的）。`,
    );
  }
  if (selfBaseOffset === null) {
    throw new Error(
      `镜像里找不到自举基址符号 ${SELF_BASE_SYM}（同上，它是位置自举的第一跳）。`,
    );
  }

  // 自举槽的**宽度**跟着架构走（x86 上它是 4 字节）
  const ptrSize = arch === 'x64' ? 8 : 4;

  // ── 9) 尾部跳板（OEP 模式专用）────────────────────────────────────────────
  //
  // 作用与为什么这么设计，见 shellcode_stub.cpp 里「尾部跳板」那一大段说明。
  // 这里只讲**字节长什么样**：
  //
  //   x64（28 字节）：
  //       48 BC <8字节占位>      mov  rsp, oepResumeStack   ← ★ 恢复原始栈指针
  //       48 B8 <8字节占位>      mov  rax, oepResume         ← 目标入口点
  //       FF E0                  jmp  rax
  //
  //   x86（13 字节）：
  //       BC <4字节占位>         mov  esp, oepResumeStack   ← ★ 恢复原始栈指针
  //       B8 <4字节占位>         mov  eax, oepResume
  //       FF E0                  jmp  eax
  //
  // ★★ 为什么**没有** `pop`，而是直接 `mov rsp, 记录值`（本方案的第二版）★★
  //
  //   第一版跳板是 `pop reg; mov reg, oep; jmp reg` —— 只弹掉 `call` 压的返回地址。
  //   那个版本在 x86 上"能跑"，在 x64 上**必崩**，原因是**漏算了 shellcode 序言**：
  //     · shellcode 是编译器生成的普通函数，序言会挪栈
  //         x64: `push rbx` + `sub rsp,0x20` → 栈低 0x28
  //         x86: `push esi`                  → 栈低 0x04
  //     · `pop` 只能抵消 `call` 自己压的 8/4 字节，**抵消不了序言那部分**
  //     · x86 偏低 4 字节落在未使用区，侥幸没出事；x64 偏低 0x28 且破坏 16 字节对齐，
  //       `mainCRTStartup` 一执行 `movaps` 就访问冲突
  //       （实测症状：Install 全部成功、日志写完，进程随后立刻消失）
  //
  //   正确做法：**不去"抵消"，而是直接恢复成记录下来的真值**。
  //   注入器改 EIP/RIP 之前把原始 rsp/esp 存进 `ctx.oepResumeStack`，
  //   跳板无条件把 rsp 设回它 —— 无论中间压了多少层，交还给入口点的栈
  //   都与"内核直接调用入口点"时逐字节一致，对齐也必然正确。
  //
  //   占位由注入器运行时回填（两个值都随 ASLR 变）：
  //     · oepResumeStack ← 内核调入口点那一刻的 rsp（注入器从线程上下文里取的）
  //     · oepResume      ← 目标进程原入口点地址
  const trampolineOffset = image.length;
  const trampBytes = arch === 'x64'
    ? [
        0x48, 0xBC, 0, 0, 0, 0, 0, 0, 0, 0,       // mov rsp, imm64
        0x48, 0xB8, 0, 0, 0, 0, 0, 0, 0, 0,       // mov rax, imm64
        0xFF, 0xE0,                               // jmp rax
      ]
    : [
        0xBC, 0, 0, 0, 0,                         // mov esp, imm32
        0xB8, 0, 0, 0, 0,                         // mov eax, imm32
        0xFF, 0xE0,                               // jmp eax
      ];
  const trampStackAt = arch === 'x64' ? 2 : 1;    // 栈指针占位起始
  const trampTargetAt = arch === 'x64' ? 12 : 6;  // 入口点占位起始
  const trampImmSize = arch === 'x64' ? 8 : 4;

  fixes.push({
    at: trampolineOffset + trampStackAt,
    size: trampImmSize,
    targetImageOffset: 0,      // 不用（见 kind）
    kind: 'oepStack',          // ← 注入器据此填 ctx.oepResumeStack
    what: 'OEP 跳板的栈指针（目标主线程原始 rsp/esp，运行时回填）',
  });
  fixes.push({
    at: trampolineOffset + trampTargetAt,
    size: trampImmSize,
    targetImageOffset: 0,      // 不用（见 kind）
    kind: 'oepResume',         // ← 注入器据此填 ctx.oepResume
    what: 'OEP 跳板的目标地址（目标进程原入口点，运行时回填）',
  });

  const full = Buffer.concat([image, Buffer.from(trampBytes)]);
  const trampolineSize = trampBytes.length;

  // ── 10) 分离"构建期已解决"与"必须运行时解决"的修正项 ──────────────────
  //
  //   · rel32：构建期就写进 image 了 → 不再需要注入器参与
  //   · abs32/abs64/oepResume：值取决于镜像**被放在哪**（或外部量）→ 运行时填
  //
  //   ⚠️ 生成的 C 表里只放 runtimeFixes。如果混进 rel32，注入器会用
  //      "镜像基址 + targetOffset"去覆盖我们已经算好的相对值 ——
  //      那是个**绝对地址**塞进 rel32 字段，行为完全错乱。
  const runtimeFixes = fixes.filter((f) => f.kind !== 'rel32');

  return {
    bytes: full,
    machine: coff.machine,
    arch,
    entryOffset: symbolImageOffset.get(entry.index),
    entryName: entry.name,
    codeSize: ordered.reduce((n, s) => n + s.rawSize, 0),
    codeSections: ordered.map((s) => ({
      index: s.index,
      name: s.name,
      imageOffset: secImageBase.get(s.index),
      size: s.rawSize,
    })),
    dataSections: dataChunks.map((c) => ({
      index: c.sec.index,
      name: c.sec.name,
      imageOffset: c.at,
      size: c.size,
    })),
    symbolTable,
    fixes,
    runtimeFixes,
    rel32Applied,
    rel32Total: fixes.filter((f) => f.kind === 'rel32').length,
    trampolineOffset,
    trampolineSize,
    bootSlotOffset,
    bootSlotSize: ptrSize,
    selfBaseOffset,
  };
}

/** 生成 C++ 头文件 */
export function emitHeader(info) {
  const L = [];
  L.push('// 本文件由 native/build.mjs 自动生成，**不要手改**。');
  L.push('//');
  L.push(`//   arch        = ${info.arch}  (machine 0x${info.machine.toString(16)})`);
  L.push(`//   入口符号    = ${info.entryName}  @ 镜像偏移 0x${info.entryOffset.toString(16)}`);
  L.push(`//   镜像总大小  = ${info.bytes.length} 字节（代码 ${info.codeSize} 字节）`);
  L.push('//');
  L.push('//   代码节（已按链接顺序拼接）：');
  for (const s of info.codeSections) {
    L.push(`//     @0x${s.imageOffset.toString(16).padStart(4, '0')}  ${s.name.padEnd(12)} ${s.size} 字节`);
  }
  L.push('//   数据节（字符串字面量）：');
  for (const s of info.dataSections) {
    L.push(`//     @0x${s.imageOffset.toString(16).padStart(4, '0')}  ${s.name.padEnd(12)} ${s.size} 字节`);
  }
  L.push('//');
  L.push(`//   自举槽      = @0x${info.bootSlotOffset.toString(16)}（${info.bootSlotSize} 字节，注入器往这里写 ctx 指针）`);
  L.push(`//   自举基址    = @0x${info.selfBaseOffset.toString(16)}（shellcode 靠它拿到自己的镜像基址）`);
  L.push(`//   尾部跳板    = @0x${info.trampolineOffset.toString(16)}（${info.trampolineSize} 字节，OEP 模式用）`);
  L.push('//');
  L.push('//   符号表（镜像偏移）：');
  for (const s of info.symbolTable) {
    L.push(`//     @0x${s.offset.toString(16).padStart(4, '0')}  ${s.name}`);
  }
  if (info.fixes.length) {
    L.push('//   需要注入器修正的绝对地址：');
    for (const f of info.fixes) {
      const desc = f.kind === 'oepResume'
        ? 'ctx.oepResume（入口点，外部值，运行时回填）'
        : f.kind === 'oepStack'
          ? 'ctx.oepResumeStack（原始栈指针，外部值，运行时回填）'
          : f.kind === 'rel32'
            ? `（rel32，构建期已就地填好）镜像 0x${f.targetImageOffset.toString(16)}`
            : `镜像 0x${f.targetImageOffset.toString(16)}  ${f.what}`;
      L.push(`//     @0x${f.at.toString(16).padStart(4, '0')}  ${f.size} 字节 → ${desc}`);
    }
  } else {
    L.push('//   ✓ 没有任何绝对地址 —— 整个镜像**位置无关**，可以搬到目标进程的任意地址。');
  }
  L.push('//');
  L.push(`//   rel32 相对引用：构建期已就地填好 ${info.rel32Applied} 处（不需要注入器参与）。`);
  L.push('//     为什么构建期能定值：注入器把镜像搬到目标进程的**一块连续内存**里，');
  L.push('//     镜像内部的相对距离原样保留 → 在"镜像坐标系"里算出的相对值搬到哪都对。');
  L.push('//     为什么必须自己算：.obj 里节与节之间的 rel32 全是**占位 0**（等链接器填），');
  L.push('//     我们跳过链接器直接拼镜像，就得自己补 —— 否则 `call` 会变成"调用下一条指令"。');
  L.push('//   排除后需注入器处理的修正项数 = ' + info.runtimeFixes.length + '（下面的表只列这些）');
  L.push('#pragma once');
  L.push('#include <cstdint>');
  L.push('');
  L.push('namespace bb {');
  L.push('');
  L.push('struct ShellcodeSym { const char* name; uint32_t offset; };');
  L.push('');
  L.push('// 修正项。kind：');
  L.push('//   0 = 填「镜像基址 + targetOffset」（镜像内的绝对地址引用）');
  L.push('//   1 = 填「ctx.oepResume」（OEP 跳板的目标入口点，外部值）');
  L.push('//   2 = 填「ctx.oepResumeStack」（OEP 跳板的栈指针，外部值）');
  L.push('struct ShellcodeFix {');
  L.push('    uint32_t at;            // 要改的字节在镜像里的偏移');
  L.push('    uint8_t  size;          // 4 或 8');
  L.push('    uint8_t  kind;          // 见上');
  L.push('    uint32_t targetOffset;  // kind==0 时用');
  L.push('};');
  L.push('');
  L.push(`inline constexpr uint32_t kShellcodeEntryOffset = ${info.entryOffset}u;`);
  L.push(`inline constexpr uint32_t kShellcodeImageSize = ${info.bytes.length}u;`);
  L.push(`inline constexpr uint32_t kShellcodeTrampolineOffset = ${info.trampolineOffset}u;`);
  L.push(`inline constexpr uint32_t kShellcodeTrampolineSize = ${info.trampolineSize}u;`);
  L.push(`inline constexpr uint32_t kShellcodeBootSlotOffset = ${info.bootSlotOffset}u;`);
  L.push(`inline constexpr uint32_t kShellcodeBootSlotSize = ${info.bootSlotSize}u;`);
  L.push(`inline constexpr uint32_t kShellcodeSelfBaseOffset = ${info.selfBaseOffset}u;`);
  L.push('');
  L.push('inline const uint8_t kShellcodeBytes[] = {');
  const row = [];
  for (let i = 0; i < info.bytes.length; i++) {
    row.push(`0x${info.bytes[i].toString(16).padStart(2, '0')}`);
    if (row.length === 16 || i === info.bytes.length - 1) {
      L.push('    ' + row.join(', ') + ',');
      row.length = 0;
    }
  }
  L.push('};');
  L.push('');
  L.push(`inline constexpr ShellcodeSym kShellcodeSymbols[] = {`);
  for (const s of info.symbolTable) {
    L.push(`    {"${s.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}", ${s.offset}u},`);
  }
  L.push('};');
  L.push('inline constexpr uint32_t kShellcodeSymbolCount = ' + info.symbolTable.length + 'u;');
  L.push('');
  L.push('// ⚠️ C++ 不允许长度为 0 的数组，所以"没有修正"时放一条哨兵，');
  L.push('//    真正的条数看 kShellcodeFixCount，不要用 sizeof 算。');
  L.push('//    （只列运行时修正项 —— rel32 已在构建期就地填好，不在这里）');
  L.push(`inline constexpr ShellcodeFix kShellcodeFixes[] = {`);
  for (const f of info.runtimeFixes) {
    const kind = f.kind === 'oepResume' ? 1 : (f.kind === 'oepStack' ? 2 : 0);
    L.push(`    {${f.at}u, ${f.size}, ${kind}u, ${f.targetImageOffset}u},`);
  }
  if (info.runtimeFixes.length === 0) L.push('    {0u, 0, 0u, 0u},   // 哨兵');
  L.push('};');
  L.push(`inline constexpr uint32_t kShellcodeFixCount = ${info.runtimeFixes.length}u;`);
  L.push('');
  L.push('} // namespace bb');
  L.push('');
  return L.join('\n');
}
