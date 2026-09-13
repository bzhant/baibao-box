import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { lz4DecompressBlock, Lz4Error } from './lz4';
import { isUnityFs, openUnityFsFile } from './unityfs';

/** 真样本：某 Unity 游戏的 Localization 字符串表（几 KB，很适合当验证对象） */
const SMALL_BUNDLE =
  process.env.BB_UNITY_SAMPLE ?? '__no_sample__';

describe('LZ4 块解压', () => {
  it('越界/非法输入会报错而不是静默产出坏数据', () => {
    expect(() => lz4DecompressBlock(Buffer.from([0xf0]), 100)).toThrow(Lz4Error);
    expect(() => lz4DecompressBlock(Buffer.from([0x00, 0x00, 0x00]), 10)).toThrow(Lz4Error); // 偏移 0
    expect(lz4DecompressBlock(Buffer.alloc(0), 0)).toHaveLength(0);
  });

  it('手搓一个块：字面量 + 回抄匹配（含重叠）', () => {
    // 目标："AAAAAAAAAA"：
    // token=0xF0 → 字面量 15(+2 个额外字节... ) 太绕，用简单形式：
    // token 高4位=1 → 1 个字面量 'A'；低4位=15 → 匹配长度 15+4=19（太多）
    // 直接构造：token=0x10 → 字面量1、匹配 4；offset=1
    const src = Buffer.from([0x10, 0x41, 0x01, 0x00]);
    // 字面量 'A' 写 1 字节；然后 offset=1，matchLen=4 → 回抄 'A'×4 = "AAAAA"
    const out = lz4DecompressBlock(src, 5);
    expect(out.toString('latin1')).toBe('AAAAA');
  });
});

describe.skipIf(!existsSync(SMALL_BUNDLE))('UnityFS 容器（真样本）', () => {
  it('识别并解析 UnityFS 头', async () => {
    const f = await openUnityFsFile(SMALL_BUNDLE);
    expect(isUnityFs(await (await import('node:fs/promises')).readFile(SMALL_BUNDLE))).toBe(true);

    const h = f.header;
    expect(h.version).toBeGreaterThan(0);
    // Unity 6 把 unityVersion 写成 "5.x.x"，真实版本在 unityRevision
    expect(h.unityRevision).toMatch(/^\d+\.\d+/);
    expect(h.compression).toBe(3); // LZ4HC
    expect(f.blocks.length).toBeGreaterThan(0);
  });

  it('★ 能把 LZ4HC 压缩的内容解压出来，且长度自洽', async () => {
    const f = await openUnityFsFile(SMALL_BUNDLE);
    const totalUncompressed = f.blocks.reduce((a, b) => a + b.uncompressedSize, 0);
    expect(f.data.length).toBe(totalUncompressed);
    expect(f.data.length).toBeGreaterThan(0);
  });

  it('解压后能看到 Unity 版本串（说明没解错）', async () => {
    const f = await openUnityFsFile(SMALL_BUNDLE);
    const text = f.data.toString('latin1');
    expect(text).toMatch(/\d+\.\d+\.\d+[a-z]\d+/); // 形如 6000.1.17f1
  });

  it('包内目录可读到文件名', async () => {
    const f = await openUnityFsFile(SMALL_BUNDLE);
    expect(f.entries.length).toBeGreaterThan(0);
    const names = f.entries.map((e) => e.name);
    expect(names.some((n) => n.length > 0)).toBe(true);
  });
});
