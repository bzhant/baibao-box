import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { logInfo, logWarn } from '@platform/logbus';

/**
 * 运行时译文的**本地存储**：`{原文: 译文}` 的扁平字典，落盘成 JSON。
 *
 * 为什么必须有它（而不是每次都问翻译接口）：
 *  - 运行时是**边玩边翻**，同一句会在每帧反复出现 —— 没有缓存就是烧钱；
 *  - 第二次启动应该**瞬时且免费**（第一次翻过的句子不该再翻一遍）；
 *  - 离线也能玩（已经翻过的部分照常显示中文）。
 *
 * 两个来源：
 *  ① **外部字典**（`seedFiles`）：社区/别的工具留下的扁平 JSON 字典，直接吃进来当预置译文；
 *  ② 我们自己翻出来的结果，回写进缓存，下次就是命中。
 *
 * 用同步 fs：宿主侧不是每帧调用的热路径（热路径在游戏进程里的桥那边），
 * 而且启动/收尾都要确保写盘完成，同步更不容易出错。
 */

/** 平坦字典文件的最小形状（原文 → 译文） */
function isFlatDict(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  let n = 0;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
    if (++n > 50) break; // 只看前若干项，避免大文件全量扫描
  }
  return true;
}

/**
 * 用户数据目录（与打包后的 app 一致：`%LOCALAPPDATA%/白的百宝箱`）。
 *
 * `BB_USER_DATA_DIR` 可覆盖 —— 测试必须能把它指到临时目录：
 * 否则测出来的"假机翻"译文会写进**用户真实的译文库**，把那款游戏的真实译文污染掉。
 */
export function userDataDir(): string {
  const override = process.env['BB_USER_DATA_DIR'];
  if (override && override.length > 0) return override;
  const base =
    process.env['APPDATA'] ??
    process.env['LOCALAPPDATA'] ??
    join(homedir(), '.local', 'share');
  return join(base, '白的百宝箱');
}

/**
 * 缓存文件路径：按**游戏路径**取哈希，一个游戏一份。
 * 放在用户数据目录而不是游戏目录 —— 不动玩家游戏里的任何文件。
 */
export function cachePathFor(gameDir: string): string {
  const h = createHash('sha1').update(gameDir.toLowerCase()).digest('hex').slice(0, 16);
  return join(userDataDir(), 'runtime-cache', `${h}.json`);
}

/** 默认会在**游戏目录**里找的"外部译文字典"文件名（存在就自动吃进来） */
export const DEFAULT_SEED_FILES = ['翻译文件.json', 'translations.json', 'bb-translation.json'];

export interface TranslationStoreLoadReport {
  /** 缓存里已有的条数 */
  cached: number;
  /** 从外部字典吃进来的条数 */
  seeded: number;
  /** 生效的外部字典文件（完整路径） */
  seedFiles: string[];
}

export class TranslationStore {
  private readonly map = new Map<string, string>();
  private dirty = false;

  constructor(private readonly cachePath: string) {}

  /**
   * 载入：先读缓存，再吃外部字典（**外部字典不覆盖缓存**：
   * 缓存里是我们按当前语言/术语翻的，优先）。
   */
  load(gameDir: string, seedFiles: readonly string[] = DEFAULT_SEED_FILES): TranslationStoreLoadReport {
    const report: TranslationStoreLoadReport = { cached: 0, seeded: 0, seedFiles: [] };

    if (existsSync(this.cachePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as unknown;
        if (isFlatDict(raw)) {
          for (const [k, v] of Object.entries(raw)) {
            if (k && typeof v === 'string' && v.length > 0) this.map.set(k, v);
          }
          report.cached = this.map.size;
        }
      } catch (e) {
        logWarn('runtime', `运行时缓存读取失败（忽略，重新积累）：${(e as Error).message}`);
      }
    }

    for (const name of seedFiles) {
      const p = join(gameDir, name);
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        if (!isFlatDict(raw)) {
          logWarn('runtime', `${name} 不是"平坦的 {原文:译文} 字典"，跳过`);
          continue;
        }
        let added = 0;
        for (const [k, v] of Object.entries(raw)) {
          if (!k || typeof v !== 'string' || v.length === 0) continue;
          if (this.map.has(k)) continue; // 缓存优先
          this.map.set(k, v);
          added++;
        }
        report.seeded += added;
        report.seedFiles.push(p);
        logInfo('runtime', `已导入外部译文字典 ${name}：+${added} 条`);
      } catch (e) {
        logWarn('runtime', `外部译文字典 ${name} 解析失败：${(e as Error).message}`);
      }
    }

    logInfo(
      'runtime',
      `译文库就绪：缓存 ${report.cached} 条 + 导入 ${report.seeded} 条 = ${this.size} 条`,
    );
    return report;
  }

  get(src: string): string | undefined {
    return this.map.get(src);
  }

  set(src: string, dst: string): void {
    if (!src || !dst || this.map.get(src) === dst) return;
    this.map.set(src, dst);
    this.dirty = true;
  }

  get size(): number {
    return this.map.size;
  }

  /** 落盘（只在有新内容时写） */
  flush(): void {
    if (!this.dirty) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      const obj: Record<string, string> = {};
      for (const [k, v] of this.map) obj[k] = v;
      writeFileSync(this.cachePath, JSON.stringify(obj, null, 0), 'utf8');
      this.dirty = false;
      logInfo('runtime', `译文缓存已保存：${this.map.size} 条 → ${this.cachePath}`);
    } catch (e) {
      logWarn('runtime', `译文缓存保存失败：${(e as Error).message}`);
    }
  }
}
