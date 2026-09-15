/**
 * 翻译接口「方案」（profile）—— **纯逻辑**，不碰文件系统、不碰 Electron。
 *
 * 为什么单独成模块：
 *   这里是"用户的密钥该怎么搬"的地方 —— 迁移逻辑一旦写错，用户已经存好的密钥就没了。
 *   把它做成纯函数，就能**不启动 Electron** 直接测（见 `api-profiles.test.ts`）。
 *   `config.ts` 只负责读盘写盘，判断全在这儿。
 *
 * 一套方案 = 一个 OpenAI 兼容端点 + 模型 + 一把密钥。用户可以存多套（DeepSeek、OpenAI、
 * 本地 Ollama、某个中转站……）随时切换 —— 因为不同游戏的文本量/语言对不一样，
 * "哪家便宜用哪家"是很实际的需求。
 */

export interface ApiProfile {
  /** 稳定标识（改名字不会丢密钥） */
  id: string;
  /** 用户可见名字 */
  name: string;
  /** OpenAI 兼容端点（不带 /chat/completions） */
  baseUrl: string;
  model: string;
  /** 预置来源：deepseek / openai / ollama / custom —— 只用于界面回填与展示 */
  preset: string;
}

export interface ApiPreset {
  preset: string;
  name: string;
  baseUrl: string;
  model: string;
  /** 界面上的说明（含坑） */
  note: string;
}

/**
 * 内置预置。**地址都是官方/惯例写法**：
 *   provider 侧拼的是 `${baseUrl}/chat/completions`，所以这里不要带尾部斜杠、也不要带具体路径。
 */
export const API_PRESETS: readonly ApiPreset[] = [
  {
    preset: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '官方接口（OpenAI 兼容）。便宜、中文好；换成 deepseek-reasoner 是推理模型，更慢更贵。',
  },
  {
    preset: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '官方接口。模型名可按需改（如 gpt-4o）。',
  },
  {
    preset: 'ollama',
    name: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    note: '本机跑模型：不联网、不花钱，但要求本机显存够，且得先 `ollama serve`。',
  },
  {
    preset: 'custom',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    note: '中转站 / 自建服务：填它给你的 OpenAI 兼容地址（通常以 /v1 结尾）。',
  },
];

/** 全新安装时的默认方案：填了地址就能用，用户只需补一把密钥 */
export function newProfileFromPreset(preset: string, id = newId()): ApiProfile {
  const p = API_PRESETS.find((x) => x.preset === preset) ?? API_PRESETS[0];
  return { id, name: p.name, baseUrl: p.baseUrl, model: p.model, preset: p.preset };
}

export function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

/** 一套新安装该长什么样（DeepSeek 预置好地址与模型，用户只要粘密钥） */
export function defaultProfiles(): ApiProfile[] {
  return [newProfileFromPreset('deepseek', 'default')];
}

/** 清洗一条方案：字段类型不对就退回默认，别把脏数据喂给 fetch */
export function normalizeProfile(raw: unknown, fallbackId = newId()): ApiProfile | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d);
  const preset = str(r['preset'], 'custom');
  const base = API_PRESETS.find((x) => x.preset === preset);
  const id = str(r['id']) || fallbackId;
  const profile: ApiProfile = {
    id,
    name: str(r['name']) || base?.name || '未命名方案',
    baseUrl: str(r['baseUrl']).trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, ''),
    model: str(r['model']).trim(),
    preset,
  };
  return profile;
}

/** 保存前的校验：返回 null 表示合法 */
export function validateProfile(p: ApiProfile): string | null {
  if (!p.name.trim()) return '方案名不能为空';
  if (!p.baseUrl.trim()) return '接口地址不能为空';
  try {
    const url = new URL(p.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return '接口地址要以 http:// 或 https:// 开头';
    if (url.username || url.password || url.search || url.hash) return '接口地址不能包含账号、密码、查询参数或锚点';
  } catch {
    return '接口地址不是有效的 URL';
  }
  if (!p.model.trim()) return '模型名不能为空';
  return null;
}

export function isLocalProfile(p: Pick<ApiProfile, 'baseUrl'>): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(p.baseUrl).hostname);
  } catch {
    return false;
  }
}

/** 一把密钥在磁盘上的样子 */
export interface StoredKey {
  value: string;
  encrypted: boolean;
}

export interface RawConfigFile {
  config?: Record<string, unknown>;
  /** 新结构：方案 id → 密钥 */
  apiKeys?: Record<string, StoredKey>;
  /** 旧结构（单套接口）：迁移用，迁移后应清掉 */
  openaiApiKey?: string;
  secretEncrypted?: boolean;
}

export interface NormalizedConfig {
  profiles: ApiProfile[];
  activeProfileId: string;
  apiKeys: Record<string, StoredKey>;
  /** 迁移过程中动过旧字段（调用方据此把旧的键从文件里删掉） */
  migrated: boolean;
}

/**
 * 把磁盘上的任意历史配置**归一**成当前结构。
 *
 * 三种情形：
 *   ① 已是新结构 → 只做清洗（脏字段退回默认）；
 *   ② 老结构（`openaiApiKey` + `openaiBaseUrl/openaiModel`）→
 *      **把老密钥搬进迁移出来的那套方案**（密钥是用户最在意的东西，绝不能丢），
 *      并保留它原本的 `encrypted` 标记（密文当明文解会解不开）；
 *   ③ 空配置 → 一套 DeepSeek 预置。
 */
export function normalizeConfigFile(raw: RawConfigFile): NormalizedConfig {
  const cfg = raw.config ?? {};
  let migrated = false;
  const keys: Record<string, StoredKey> = {};
  for (const [k, v] of Object.entries(raw.apiKeys ?? {})) {
    if (v && typeof v === 'object' && typeof (v as StoredKey).value === 'string') {
      keys[k] = { value: (v as StoredKey).value, encrypted: !!(v as StoredKey).encrypted };
    }
  }

  // ① / ② 方案列表
  let profiles: ApiProfile[] = [];
  if (Array.isArray(cfg['profiles'])) {
    profiles = (cfg['profiles'] as unknown[])
      .map((p) => normalizeProfile(p))
      .filter((p): p is ApiProfile => p !== null);
    const seen = new Set<string>();
    profiles = profiles.map((p) => {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        return p;
      }
      migrated = true;
      const id = newId();
      seen.add(id);
      return { ...p, id };
    });
  }

  const oldKey = typeof raw.openaiApiKey === 'string' ? raw.openaiApiKey : '';
  if (profiles.length === 0) {
    if (oldKey) {
      // 老用户：**必须把密钥带走**，方案名与地址沿用他原来填的
      const legacy: ApiProfile = {
        id: 'migrated',
        name: '我的接口',
        baseUrl: typeof cfg['openaiBaseUrl'] === 'string' ? String(cfg['openaiBaseUrl']) : 'https://api.openai.com/v1',
        model: typeof cfg['openaiModel'] === 'string' ? String(cfg['openaiModel']) : 'gpt-4o-mini',
        preset: 'custom',
      };
      profiles = [legacy];
      if (!keys[legacy.id]) {
        keys[legacy.id] = { value: oldKey, encrypted: raw.secretEncrypted ?? false };
      }
      migrated = true;
    } else {
      profiles = defaultProfiles();
    }
  }
  // 迁移后清掉旧键（避免同一把密钥在文件里出现两次，也避免下次又走一遍迁移）
  if (oldKey) migrated = true;

  // ③ 当前启用哪套：指向不存在的方案就退回第一个
  const wantActive = typeof cfg['activeProfileId'] === 'string' ? String(cfg['activeProfileId']) : '';
  const activeProfileId = profiles.some((p) => p.id === wantActive) ? wantActive : profiles[0].id;

  return { profiles, activeProfileId, apiKeys: keys, migrated };
}

/** 新增或更新一套方案（按 id 匹配；不改动其它方案） */
export function upsertProfile(list: readonly ApiProfile[], p: ApiProfile): ApiProfile[] {
  const i = list.findIndex((x) => x.id === p.id);
  if (i < 0) return [...list, p];
  const next = [...list];
  next[i] = p;
  return next;
}

/** 删除一套方案；**至少留一套**（否则界面与 provider 解析会同时失去目标） */
export function deleteProfile(
  profiles: readonly ApiProfile[],
  activeProfileId: string,
  id: string,
): { profiles: ApiProfile[]; activeProfileId: string; error?: string } {
  if (profiles.length <= 1) {
    return { profiles: [...profiles], activeProfileId, error: '至少要保留一套方案' };
  }
  const next = profiles.filter((p) => p.id !== id);
  return {
    profiles: next,
    activeProfileId: activeProfileId === id ? next[0].id : activeProfileId,
  };
}
