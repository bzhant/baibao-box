import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseSerializedHeader, parseSerializedFile, describeSerialized } from './serialized';
import { openUnityFs, readEntry } from './unityfs';

/**
 * 真样本：某 Unity 6 游戏的 Localization 字符串表（bundle 内嵌 SerializedFile）。
 * 该样本把 Unity 6 的 **i64 头变体** 暴露了出来（classic 布局解析不通）。
 */
const BUNDLE =
  process.env.BB_UNITY_SAMPLE ?? '__no_sample__';

function inner(): Buffer {
  const f = openUnityFs(readFileSync(BUNDLE));
  return readEntry(f, f.entries[0].name) ?? f.data;
}

describe('SerializedFile 头变体识别', () => {
  it('垃圾数据判为未知变体，不硬猜', () => {
    const junk = Buffer.alloc(64, 0xab);
    expect(parseSerializedHeader(junk).variant).toBe('unknown');
  });

  it('过短的数据不崩', () => {
    expect(parseSerializedHeader(Buffer.alloc(4)).variant).toBe('unknown');
  });
});

describe.skipIf(!existsSync(BUNDLE))('SerializedFile（真样本 / Unity 6）', () => {
  it('★ 识别出 i64 头变体（classic 布局读出来是 0）', () => {
    const h = parseSerializedHeader(inner());
    expect(h.variant).toBe('i64');
    expect(h.version).toBe(22);
    expect(h.fileSize).toBe(inner().length);
    expect(h.metadataSize).toBeGreaterThan(0);
    // 元数据紧跟 48 字节头
    expect(h.metadataOffset).toBe(48);
    expect(h.endianness).toBe(0); // 小端
  });

  it('解析元数据：unityVersion / targetPlatform / 类型树可用', () => {
    const sf = parseSerializedFile(inner());
    expect(sf.unityVersion).toMatch(/^6000\./);
    expect(sf.targetPlatform).toBe(19); // StandaloneWindows64
    expect(sf.enableTypeTree).toBe(true); // 这个样本没剥离类型树
    expect(sf.types.length).toBeGreaterThan(0);
    console.log('[serialized]', describeSerialized(sf));
    if (sf.warnings.length) console.log('[serialized] 警告:', sf.warnings.join(' | '));
  });

  it('★ 第一个类型（AssetBundle）的类型树完全解析正确', () => {
    const sf = parseSerializedFile(inner());
    const t0 = sf.types[0];
    expect(t0.classID).toBe(142); // AssetBundle
    expect(t0.nodes[0].type).toBe('AssetBundle');

    // 字段名来自**本地**字符串缓冲区 → 能证明类型树解析结构正确
    const localNames = t0.nodes.map((n) => n.name).filter(Boolean);
    expect(localNames).toContain('m_PreloadTable');
    expect(localNames).toContain('m_Container');
    expect(localNames).toContain('m_AssetBundleName');
    console.log('[serialized] AssetBundle 树本地字段:', localNames.slice(0, 10).join(', '));
  });

  it('公共字符串引用被如实标出索引（不猜名字）', () => {
    const sf = parseSerializedFile(inner());
    const all = sf.types.flatMap((t) => t.nodes);
    const common = all.filter((n) => n.nameCommonIndex !== null || n.typeCommonIndex !== null);
    expect(common.length).toBeGreaterThan(0);
    for (const n of common) {
      if (n.nameCommonIndex !== null) expect(n.name).toBe('');
      if (n.typeCommonIndex !== null) expect(n.type).toBe('');
    }
    console.log('[serialized] 公共字符串引用数:', common.length);
  });

  it('已知局限：第一个类型之后未能解析时，如实记 warning 而非给错数据', () => {
    const sf = parseSerializedFile(inner());
    // 这个样本 typeCount=2，但第 2 个（MonoBehaviour/StringTable）布局尚未对通
    if (sf.types.length < 2) {
      expect(sf.warnings.length).toBeGreaterThan(0);
      expect(sf.warnings.join(' ')).toContain('类型 #1 解析失败');
      // 不再继续读对象表（偏移已不可信）
      expect(sf.objects).toEqual([]);
    }
  });
});
