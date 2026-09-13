import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  API_PRESETS,
  defaultProfiles,
  deleteProfile as removeProfile,
  newProfileFromPreset,
  normalizeConfigFile,
  normalizeProfile,
  upsertProfile as upsertIn,
  validateProfile,
  type ApiProfile,
  type NormalizedConfig,
  type StoredKey,
} from './api-profiles';

/**
 * 方案结构定义在纯模块里（可脱离 Electron 测）；这里转出去，让调用方只认一个入口。
 */
export type { ApiProfile, ApiPreset, StoredKey } from './api-profiles';
export { API_PRESETS } from './api-profiles';

/**
 * 应用配置。
 *
 * ── 四个要点 ──
 *
 * ① **配置和数据分开存**：这里只放"用户偏好"，不放游戏文本库
 *    （文本库在 store/，位置由 init.ts 决定）。混在一起会让"清缓存"变成危险操作。
 *
 * ② **API Key 用 Electron 的 `safeStorage` 加密存**（Windows 上走 DPAPI，绑定当前用户）。
 *    不加密地明文写在 json 里，等于把密钥摊在文件系统上，
 *    任何能读这个文件的东西都能拿去用 —— 而用户是看不到这个文件的。
 *    `safeStorage` 不可用时**降级为明文，但明确记下来**（`encrypted: false`），
 *    让用户知道现状，而不是以为已经加密了。
 *
 * ③ **支持多套接口方案**（`ApiProfile`）：不同游戏的文本量/语言对不同，
 *    "哪家便宜用哪家"是很实际的需求。每套方案各存各的密钥 —— 换方案不用重新粘密钥。
 *    迁移与增删改的判断都在 `api-profiles.ts`（纯函数，有测试）。
 *
 * ④ **写入用"读-改-写"并且带默认值合并**：以后加字段时老配置文件不会缺键崩掉。
 *
 * ⚠️ 本模块是**主进程专属**（用了 electron 的 app/safeStorage）。
 *    渲染层只能通过 IPC 拿到"方案列表"与"有没有密钥"，**永远拿不到密钥本身**。
 */

export interface AppConfig {
  /** 当前启用哪套接口方案 */
  activeProfileId: string;
  /** 所有接口方案 */
  profiles: ApiProfile[];
  /** 界面上没填时的默认翻译方向 */
  defaultFrom: string;
  defaultTo: string;
  /** 每次送给 Provider 的批大小（影响速度与成本） */
  batchSize: number;
  /** 并发上限 */
  concurrency: number;
  /** 回写前是否自动备份（**强烈建议保持 true**，关掉就失去可逆性） */
  backupBeforeRepack: boolean;
}

/** 默认值。键名与含义集中在这里，别的模块不要再写一遍字面量。 */
export function defaultConfig(): AppConfig {
  const profiles = defaultProfiles();
  return {
    activeProfileId: profiles[0].id,
    profiles,
    defaultFrom: 'ja',
    defaultTo: 'zh-CN',
    batchSize: 20,
    concurrency: 4,
    backupBeforeRepack: true,
  };
}

/** 磁盘上的文件结构：配置 + 密钥分开放，便于理解与排查 */
interface ConfigFile {
  version: number;
  config: AppConfig;
  /** 方案 id → 密钥（密文，或降级时的明文） */
  apiKeys: Record<string, StoredKey>;
}

let cached: ConfigFile | null = null;

function configPath(): string {
  // 与文本库同级都放在 userData 下（Electron 保证这个目录可写）
  return join(app.getPath('userData'), 'config.json');
}

/** 把磁盘上的任意历史结构归一成当前结构（判断全在纯模块里） */
function applyNormalized(raw: unknown): { file: ConfigFile; migrated: boolean } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const defaults = defaultConfig();
  const n: NormalizedConfig = normalizeConfigFile({
    config: (r['config'] ?? {}) as Record<string, unknown>,
    apiKeys: r['apiKeys'] as Record<string, StoredKey> | undefined,
    openaiApiKey: typeof r['openaiApiKey'] === 'string' ? r['openaiApiKey'] : undefined,
    secretEncrypted: typeof r['secretEncrypted'] === 'boolean' ? r['secretEncrypted'] : undefined,
  });
  const saved = (r['config'] ?? {}) as Partial<AppConfig>;
  return {
    file: {
      version: 2,
      config: {
        defaultFrom: saved.defaultFrom ?? defaults.defaultFrom,
        defaultTo: saved.defaultTo ?? defaults.defaultTo,
        batchSize: saved.batchSize ?? defaults.batchSize,
        concurrency: saved.concurrency ?? defaults.concurrency,
        backupBeforeRepack: saved.backupBeforeRepack ?? defaults.backupBeforeRepack,
        profiles: n.profiles,
        activeProfileId: n.activeProfileId,
      },
      apiKeys: n.apiKeys,
    },
    migrated: n.migrated,
  };
}

function load(): ConfigFile {
  if (cached) return cached;
  const p = configPath();
  let raw: unknown = {};
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    } catch {
      // 配置坏了不该让应用起不来：退回默认值，并在日志里说明
      raw = {};
    }
  }
  const { file, migrated } = applyNormalized(raw);
  cached = file;
  // 迁移过就**立刻落盘**：老的 `openaiApiKey` 必须在这一步被清掉，
  // 否则同一把密钥在文件里留两份，下次启动还要再迁一遍。
  if (migrated) {
    try {
      persist();
    } catch {
      /* 落盘失败不影响本次运行（内存里已经是新结构了） */
    }
  }
  return cached;
}

function persist(): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(load(), null, 2), 'utf8');
}

export function getConfig(): AppConfig {
  return { ...load().config };
}

/**
 * 改标量偏好（语言、批大小、并发、备份开关）。
 *
 * **刻意不接受 `profiles` / `activeProfileId`** —— 方案有专门的函数。
 * 走这里容易被"整体覆盖"误伤（界面回传一个旧列表就把新加的方案抹掉）。
 */
export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const f = load();
  const { profiles: _p, activeProfileId: _a, ...safe } = patch;
  f.config = { ...f.config, ...safe };
  persist();
  return { ...f.config };
}

// ── 接口方案 ────────────────────────────────────────────────────────

/** 界面可见的方案信息（**不含密钥内容**，只有"有没有""是否加密"） */
export interface ProfileView extends ApiProfile {
  hasKey: boolean;
  encrypted: boolean;
  isActive: boolean;
}

export function listProfiles(): ProfileView[] {
  const f = load();
  return f.config.profiles.map((p) => ({
    ...p,
    hasKey: (f.apiKeys[p.id]?.value ?? '').length > 0,
    encrypted: f.apiKeys[p.id]?.encrypted ?? false,
    isActive: p.id === f.config.activeProfileId,
  }));
}

export function activeProfile(): ApiProfile {
  const f = load();
  return f.config.profiles.find((p) => p.id === f.config.activeProfileId) ?? f.config.profiles[0];
}

/** 新增或更新一套方案（校验不过就抛错，让界面显示原因） */
export function saveProfile(input: Partial<ApiProfile> & { id?: string }): ApiProfile {
  const f = load();
  const existing = input.id ? f.config.profiles.find((p) => p.id === input.id) : undefined;
  const merged = normalizeProfile(
    existing ? { ...existing, ...input } : { ...newProfileFromPreset(input.preset ?? 'custom'), ...input },
    input.id,
  );
  if (!merged) throw new Error('方案数据不合法');
  const bad = validateProfile(merged);
  if (bad) throw new Error(bad);
  f.config.profiles = upsertIn(f.config.profiles, merged);
  persist();
  return merged;
}

export function deleteProfileById(id: string): { ok: boolean; error?: string; activeProfileId: string } {
  const f = load();
  const r = removeProfile(f.config.profiles, f.config.activeProfileId, id);
  if (r.error) return { ok: false, error: r.error, activeProfileId: f.config.activeProfileId };
  f.config.profiles = r.profiles;
  f.config.activeProfileId = r.activeProfileId;
  delete f.apiKeys[id];
  persist();
  return { ok: true, activeProfileId: f.config.activeProfileId };
}

export function activateProfile(id: string): ApiProfile {
  const f = load();
  if (!f.config.profiles.some((p) => p.id === id)) throw new Error('找不到这套方案');
  f.config.activeProfileId = id;
  persist();
  return activeProfile();
}

// ── 密钥 ────────────────────────────────────────────────────────────

/** 某套方案是否配了密钥 */
export function hasKeyFor(profileId: string): boolean {
  return (load().apiKeys[profileId]?.value ?? '').length > 0;
}

/** 当前方案是否配了密钥（界面据此显示"已配置/未配置"） */
export function hasApiKey(): boolean {
  return hasKeyFor(load().config.activeProfileId);
}

/**
 * 取某套方案的明文密钥（**只在主进程内部用**，绝不通过 IPC 发给渲染层）。
 *
 * ⚠️ 界面永远只能知道"有没有配"，不能读到密钥本身 ——
 *    否则渲染层被注入脚本就等于密钥泄露。IPC 层只暴露状态与"设置"。
 */
export function getProfileKey(profileId: string): string {
  const k = load().apiKeys[profileId];
  if (!k?.value) return '';
  let plain: string;
  if (!k.encrypted) {
    plain = k.value; // 降级存的明文
  } else {
    try {
      plain = safeStorage.decryptString(Buffer.from(k.value, 'base64'));
    } catch {
      // 换机器/换用户后 DPAPI 解不开 —— 当作没配，而不是崩掉
      return '';
    }
  }
  // ★ 一律去掉首尾空白。粘贴密钥时带上换行/空格是**最常见的故障**：
  //   密钥看起来"填了"，但 `Bearer sk-xxx\n` 会被接口判为无效。
  //   这里清洗，等于让已经存坏的那些密钥**自愈**，不用用户重新粘一遍。
  return plain.trim();
}

/** 当前方案的密钥（provider 用这个） */
export function getActiveApiKey(): string {
  return getProfileKey(load().config.activeProfileId);
}

/** 兼容旧调用点：等价于"当前方案的密钥" */
export function getApiKey(): string {
  return getActiveApiKey();
}

/** 设置某套方案的密钥（空串 = 清除） */
export function setProfileKey(profileId: string, key: string): { encrypted: boolean } {
  const f = load();
  if (!f.config.profiles.some((p) => p.id === profileId)) throw new Error('找不到这套方案');
  // 先清洗首尾空白；如果清洗后仍含空白，说明粘进来的不只是密钥（比如带上了说明文字）
  const cleaned = key.trim();
  if (cleaned && /\s/.test(cleaned)) {
    throw new Error('密钥中间有空格或换行 —— 多半是粘贴时带上了别的内容，请只复制密钥本身');
  }
  key = cleaned;
  if (!key) {
    delete f.apiKeys[profileId];
    persist();
    return { encrypted: false };
  }
  // 可用就用 safeStorage 加密；不可用则如实降级并标记
  if (safeStorage.isEncryptionAvailable()) {
    f.apiKeys[profileId] = { value: safeStorage.encryptString(key).toString('base64'), encrypted: true };
  } else {
    f.apiKeys[profileId] = { value: key, encrypted: false };
  }
  persist();
  return { encrypted: f.apiKeys[profileId].encrypted };
}

/** 兼容旧调用点：给**当前方案**设密钥 */
export function setApiKey(key: string): { encrypted: boolean } {
  return setProfileKey(load().config.activeProfileId, key);
}

/** 供界面显示的状态（**不含密钥本身**） */
export function configStatus(): {
  hasApiKey: boolean;
  secretEncrypted: boolean;
  path: string;
  config: AppConfig;
  profiles: ProfileView[];
  activeProfile: ApiProfile;
  /** 内置预置（界面用它渲染"新增方案"的按钮）——**从主进程送过去** */
  presets: typeof API_PRESETS;
} {
  const f = load();
  const active = activeProfile();
  return {
    hasApiKey: hasKeyFor(active.id),
    secretEncrypted: f.apiKeys[active.id]?.encrypted ?? false,
    path: configPath(),
    config: { ...f.config },
    profiles: listProfiles(),
    activeProfile: active,
    presets: API_PRESETS,
  };
}
