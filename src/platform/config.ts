import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 应用配置。
 *
 * 之前所有可配置项都只能靠**环境变量**（例如 `BAIBAO_OPENAI_API_KEY`）——
 * 这对命令行很自然，但图形界面用户根本没法填。这个模块把配置落到磁盘文件。
 *
 * ── 三个要点 ──
 *
 * ① **配置和数据分开存**：这里只放"用户偏好"，不放游戏文本库
 *    （文本库在 store/，位置由 init.ts 决定）。混在一起会让"清缓存"变成危险操作。
 *
 * ② **API Key 用 Electron 的 `safeStorage` 加密存**（Windows 上走 DPAPI，绑定当前用户）。
 *    不加密地明文写在 json 里，等于把密钥摊在文件系统上，
 *    任何能读这个文件的东西都能拿去用 —— 而用户是看不到这个文件的。
 *    `safeStorage` 不可用时**降级为明文，但明确记下来**（`secretEncrypted: false`），
 *    让用户知道现状，而不是以为已经加密了。
 *
 * ③ **写入用"读-改-写"并且带默认值合并**：以后加字段时老配置文件不会缺键崩掉。
 */

export interface AppConfig {
  /** OpenAI 兼容接口 */
  openaiBaseUrl: string;
  openaiModel: string;
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
export const DEFAULT_CONFIG: AppConfig = {
  openaiBaseUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o-mini',
  defaultFrom: 'ja',
  defaultTo: 'zh-CN',
  batchSize: 20,
  concurrency: 4,
  backupBeforeRepack: true,
};

/** 磁盘上的文件结构：配置 + 密文密钥分开放，便于理解与排查 */
interface ConfigFile {
  config: AppConfig;
  /** 是否用 safeStorage 加密过（false = 明文，见文件头说明） */
  secretEncrypted: boolean;
  /** base64 的密文，或（降级时）明文 */
  openaiApiKey: string;
}

let cached: ConfigFile | null = null;

function configPath(): string {
  // 与文本库同级都放在 userData 下（Electron 保证这个目录可写）
  return join(app.getPath('userData'), 'config.json');
}

function load(): ConfigFile {
  if (cached) return cached;
  const p = configPath();
  let raw: Partial<ConfigFile> = {};
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<ConfigFile>;
    } catch {
      // 配置坏了不该让应用起不来：退回默认值，并在日志里说明
      raw = {};
    }
  }
  cached = {
    // 合并默认值：以后新增字段时，老配置文件不会缺键
    config: { ...DEFAULT_CONFIG, ...(raw.config ?? {}) },
    secretEncrypted: raw.secretEncrypted ?? false,
    openaiApiKey: raw.openaiApiKey ?? '',
  };
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

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const f = load();
  f.config = { ...f.config, ...patch };
  persist();
  return { ...f.config };
}

/** 密钥是否可用（界面据此决定显示"已配置"还是提示去填） */
export function hasApiKey(): boolean {
  return load().openaiApiKey.length > 0;
}

/**
 * 取明文密钥（**只在主进程内部用**，绝不通过 IPC 发给渲染层）。
 *
 * ⚠️ 界面永远只能知道"有没有配"，不能读到密钥本身 ——
 *    否则渲染层被注入脚本就等于密钥泄露。IPC 层只暴露 `hasApiKey` 与"设置"。
 */
export function getApiKey(): string {
  const f = load();
  if (!f.openaiApiKey) return '';
  if (!f.secretEncrypted) return f.openaiApiKey; // 降级存的明文
  try {
    return safeStorage.decryptString(Buffer.from(f.openaiApiKey, 'base64'));
  } catch {
    // 换机器/换用户后 DPAPI 解不开 —— 当作没配，而不是崩掉
    return '';
  }
}

/** 设置密钥（空串 = 清除） */
export function setApiKey(key: string): { encrypted: boolean } {
  const f = load();
  if (!key) {
    f.openaiApiKey = '';
    f.secretEncrypted = false;
    persist();
    return { encrypted: false };
  }
  // 可用就用 safeStorage 加密；不可用则如实降级并标记
  if (safeStorage.isEncryptionAvailable()) {
    f.openaiApiKey = safeStorage.encryptString(key).toString('base64');
    f.secretEncrypted = true;
  } else {
    f.openaiApiKey = key;
    f.secretEncrypted = false;
  }
  persist();
  return { encrypted: f.secretEncrypted };
}

/** 供界面显示的状态（**不含密钥本身**） */
export function configStatus(): {
  hasApiKey: boolean;
  secretEncrypted: boolean;
  path: string;
  config: AppConfig;
} {
  const f = load();
  return {
    hasApiKey: f.openaiApiKey.length > 0,
    secretEncrypted: f.secretEncrypted,
    path: configPath(),
    config: { ...f.config },
  };
}
