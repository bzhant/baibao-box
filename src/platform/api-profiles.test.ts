import { describe, expect, it } from 'vitest';
import {
  API_PRESETS,
  defaultProfiles,
  deleteProfile,
  newProfileFromPreset,
  normalizeConfigFile,
  normalizeProfile,
  upsertProfile,
  validateProfile,
} from './api-profiles';

/**
 * 「多方案」的纯逻辑测试。
 *
 * 最要紧的一条：**老用户的密钥不能在迁移里丢**。
 * 密钥是用户自己掏钱买的东西，丢了他得重新去申请一遍 —— 这是本模块存在的全部理由。
 */

describe('预置方案', () => {
  it('DeepSeek 预置了正确的地址与模型（provider 侧会拼 /chat/completions）', () => {
    const d = API_PRESETS.find((p) => p.preset === 'deepseek');
    expect(d, '必须有 DeepSeek 预置').toBeTruthy();
    expect(d?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(d?.baseUrl.endsWith('/')).toBe(false); // 尾部斜杠会让拼出来的 URL 变成 //chat/...
    expect(d?.model).toBe('deepseek-chat');
  });

  it('每个预置的地址都不带具体路径（由 provider 拼 /chat/completions）', () => {
    for (const p of API_PRESETS) {
      if (p.preset === 'custom') continue; // 自定义允许为空
      expect(p.baseUrl.endsWith('/chat/completions'), `${p.preset} 不该自带 chat 路径`).toBe(false);
    }
  });

  it('全新安装：一套 DeepSeek 方案，地址已填好', () => {
    const list = defaultProfiles();
    expect(list).toHaveLength(1);
    expect(list[0].baseUrl).toBe('https://api.deepseek.com/v1');
    expect(list[0].model).toBe('deepseek-chat');
  });

  it('从预置新建不会共用同一个 id（否则改一个会影响另一个）', () => {
    const a = newProfileFromPreset('deepseek');
    const b = newProfileFromPreset('deepseek');
    expect(a.id).not.toBe(b.id);
  });
});

describe('归一 / 迁移', () => {
  it('全新配置 → 一套 DeepSeek', () => {
    const n = normalizeConfigFile({});
    expect(n.profiles).toHaveLength(1);
    expect(n.activeProfileId).toBe(n.profiles[0].id);
    expect(n.apiKeys).toEqual({});
  });

  it('★ 老配置：密钥必须搬进迁移出来的方案，且保留加密标记', () => {
    const n = normalizeConfigFile({
      config: { openaiBaseUrl: 'https://api.openai.com/v1', openaiModel: 'gpt-4o' },
      openaiApiKey: 'CIPHERTEXT',
      secretEncrypted: true,
    });
    expect(n.profiles).toHaveLength(1);
    const id = n.profiles[0].id;
    expect(n.profiles[0].model).toBe('gpt-4o'); // 沿用用户原来填的
    expect(n.profiles[0].baseUrl).toBe('https://api.openai.com/v1');
    expect(n.apiKeys[id], '老密钥必须出现在新结构里').toEqual({ value: 'CIPHERTEXT', encrypted: true });
    expect(n.activeProfileId).toBe(id);
    expect(n.migrated, '要告诉调用方清掉旧字段').toBe(true);
  });

  it('★ 老配置（明文降级存过）：不加密封记，别把明文当密文解', () => {
    const n = normalizeConfigFile({ openaiApiKey: 'sk-plaintext', secretEncrypted: false });
    const id = n.profiles[0].id;
    expect(n.apiKeys[id]).toEqual({ value: 'sk-plaintext', encrypted: false });
  });

  it('已是新结构：原样保留，多套方案都在', () => {
    const n = normalizeConfigFile({
      config: {
        profiles: [
          { id: 'a', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', preset: 'deepseek' },
          { id: 'b', name: '中转站', baseUrl: 'https://x.example/v1', model: 'm', preset: 'custom' },
        ],
        activeProfileId: 'b',
      },
      apiKeys: { a: { value: 'k1', encrypted: true }, b: { value: 'k2', encrypted: true } },
    });
    expect(n.profiles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(n.activeProfileId).toBe('b');
    expect(Object.keys(n.apiKeys)).toHaveLength(2);
    expect(n.migrated).toBe(false);
  });

  it('启用 id 指向不存在的方案 → 退回第一套（而不是让上层拿到 undefined）', () => {
    const n = normalizeConfigFile({
      config: { profiles: [{ id: 'a', name: 'A', baseUrl: 'https://a/v1', model: 'm' }], activeProfileId: '不存在' },
    });
    expect(n.activeProfileId).toBe('a');
  });

  it('脏数据（地址带尾斜杠 / 缺字段）被清洗，不会喂给 fetch', () => {
    const n = normalizeConfigFile({
      config: { profiles: [{ id: 'x', baseUrl: 'https://a.example/v1///', name: '' }] },
    });
    expect(n.profiles[0].baseUrl).toBe('https://a.example/v1');
    // 方案名为空 → 回填预置名（比显示"未命名方案"有用）
    expect(n.profiles[0].name).toBe('自定义（OpenAI 兼容）');
    expect(n.profiles[0].model).toBe('');
  });

  it('非对象 / 空数组等异常输入不抛异常', () => {
    expect(() => normalizeProfile(null)).not.toThrow();
    expect(normalizeProfile(null)).toBeNull();
    expect(normalizeConfigFile({ config: { profiles: [] } }).profiles.length).toBeGreaterThan(0);
  });
});

describe('增删改', () => {
  it('upsert 按 id 更新，不动其它方案', () => {
    const a = newProfileFromPreset('deepseek', 'a');
    const b = newProfileFromPreset('openai', 'b');
    const next = upsertProfile([a, b], { ...a, model: 'deepseek-reasoner' });
    expect(next).toHaveLength(2);
    expect(next.find((p) => p.id === 'a')?.model).toBe('deepseek-reasoner');
    expect(next.find((p) => p.id === 'b')?.model).toBe('gpt-4o-mini');
  });

  it('upsert 新 id 则追加', () => {
    const a = newProfileFromPreset('deepseek', 'a');
    const next = upsertProfile([a], newProfileFromPreset('openai', 'c'));
    expect(next.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('删掉当前启用那套 → 自动切到剩下的第一套', () => {
    const a = newProfileFromPreset('deepseek', 'a');
    const b = newProfileFromPreset('openai', 'b');
    const r = deleteProfile([a, b], 'a', 'a');
    expect(r.profiles.map((p) => p.id)).toEqual(['b']);
    expect(r.activeProfileId).toBe('b');
  });

  it('只剩一套时拒绝删除（否则没有可用的目标了）', () => {
    const a = newProfileFromPreset('deepseek', 'a');
    const r = deleteProfile([a], 'a', 'a');
    expect(r.profiles).toHaveLength(1);
    expect(r.error).toBeTruthy();
  });

  it('校验：地址必须是 http(s)，模型名不能空', () => {
    const base = newProfileFromPreset('custom', 'x');
    expect(validateProfile(base)).toBeTruthy(); // 自定义预置地址为空 → 不合法

    expect(validateProfile({ ...base, baseUrl: 'ftp://a', model: 'm' })).toContain('http');
    expect(validateProfile({ ...base, baseUrl: 'https://a/v1', model: '  ' })).toContain('模型名');
    expect(validateProfile({ ...base, baseUrl: 'https://a/v1', model: 'm', name: ' ' })).toContain('方案名');
    expect(validateProfile({ ...base, baseUrl: 'https://a/v1', model: 'm' })).toBeNull();
  });
});
