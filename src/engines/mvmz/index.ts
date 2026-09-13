import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type {
  EngineAdapter,
  DetectResult,
  TextEntry,
  RepackResult,
  FontInjectOutcome,
} from '@shared/contracts';
import { extractEventText, isEventFile } from './event-text';
import { injectCjkFont as injectFontImpl, restoreCjkFont as restoreFontImpl } from './font';
import { applyPatch, relPath, type PatchFileInput } from '@platform/patch';

/**
 * 引擎适配器：RPG Maker MV / MZ（P0，最高优先级）。
 *
 * 路线：**静态解析**，无需注入。
 *  - 项目态：`data/*.json`；发布态：`www/data/*.json`
 *
 * 抽取覆盖两类文本：
 *  1. 数据库字段（角色/物品/技能/状态/装备 的 名称+描述）—— DB_FIELDS 白名单
 *  2. 事件对白（Map/CommonEvents/Troops 的 显示文本/选项 指令流）—— event-text.ts
 *
 * 两类条目统一用 JSON-pointer 定位（`文件#/段/段/…`），repack 通用回写。
 */

const ENGINE_ID = 'mvmz';

/**
 * CryptoJS / OpenSSL AES 密文的 base64 前缀（`U2FsdGVkX1` = base64("Salted__")）。
 *
 * 实测发现：部分 MV/MZ 游戏会把 `data/*.json` 加密（把 CryptoJS 内联进
 * rmmz_managers.js，运行时解密），并在 `js/plugins.js` 里做混淆。
 * 这是**游戏自身的防篡改**，不是本工具的对手。静态抽取对这类游戏无效，
 * 必须让用户看到明确原因，而不是"抽到 0 条"。
 */
export const CRYPTOJS_B64_PREFIX = 'U2FsdGVkX1';

/** 文本是否看起来是 CryptoJS/OpenSSL 加密后的数据 */
export function looksEncryptedData(text: string): boolean {
  return text.slice(0, CRYPTOJS_B64_PREFIX.length) === CRYPTOJS_B64_PREFIX;
}

// ── System.json 的可翻译字段白名单 ────────────────────────────
// 这些字符串会直接出现在游戏的菜单/界面上，属于必须翻的部分。
// 注意**不做**盲目的深度遍历：System.json 里还有 sounds[].name（音效资源名）、
// battlebackName 等资源路径，翻错了游戏就崩。

/** 字符串数组型字段（菜单里的分类名，索引 0 是空占位） */
const SYSTEM_ARRAY_FIELDS = ['armorTypes', 'elements', 'equipTypes', 'skillTypes', 'weaponTypes'] as const;
/** 单字符串字段 */
const SYSTEM_STRING_FIELDS = ['gameTitle', 'currencyUnit'] as const;
/** terms 下的字符串数组 */
const TERM_ARRAY_FIELDS = ['basic', 'commands', 'params'] as const;

export interface SystemTextSlot {
  /** JSON-pointer 段（不含文件部分） */
  pointer: string[];
  key: string;
  source: string;
}

/** 抽取 System.json 里用户可见的文本 */
export function extractSystemText(sys: unknown): SystemTextSlot[] {
  const out: SystemTextSlot[] = [];
  if (!sys || typeof sys !== 'object') return out;
  const root = sys as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

  for (const f of SYSTEM_STRING_FIELDS) {
    if (ok(root[f])) out.push({ pointer: [f], key: f, source: root[f] });
  }
  for (const f of SYSTEM_ARRAY_FIELDS) {
    const arr = root[f];
    if (Array.isArray(arr)) {
      arr.forEach((v, i) => {
        if (ok(v)) out.push({ pointer: [f, String(i)], key: f, source: v });
      });
    }
  }
  const terms = root.terms;
  if (terms && typeof terms === 'object') {
    const t = terms as Record<string, unknown>;
    for (const f of TERM_ARRAY_FIELDS) {
      const arr = t[f];
      if (Array.isArray(arr)) {
        arr.forEach((v, i) => {
          if (ok(v)) out.push({ pointer: ['terms', f, String(i)], key: `terms.${f}`, source: v });
        });
      }
    }
    const msgs = t.messages;
    if (msgs && typeof msgs === 'object') {
      for (const [k, v] of Object.entries(msgs as Record<string, unknown>)) {
        if (ok(v)) out.push({ pointer: ['terms', 'messages', k], key: 'terms.messages', source: v });
      }
    }
  }
  return out;
}

/** 各数据库文件中需要翻译的字段（白名单，区分 显示文本 / 代码 / 资源路径） */
const DB_FIELDS: Record<string, string[]> = {
  'Actors.json': ['name', 'nickname', 'profile'],
  'Classes.json': ['name'],
  'Items.json': ['name', 'description'],
  'Skills.json': ['name', 'description', 'message1', 'message2'],
  'Weapons.json': ['name', 'description'],
  'Armors.json': ['name', 'description'],
  'States.json': ['name', 'message1', 'message2', 'message3', 'message4'],
  'Enemies.json': ['name'],
  'MapInfos.json': ['name'],
};

/** 找数据目录（项目态 data/ 或 发布态 www/data/） */
async function findDataDir(gameDir: string): Promise<string | null> {
  for (const rel of ['data', join('www', 'data')]) {
    const dir = join(gameDir, rel);
    try {
      const st = await fs.stat(join(dir, 'System.json'));
      if (st.isFile()) return dir;
    } catch {
      /* 不存在则继续 */
    }
  }
  return null;
}

function relOf(dataDir: string, gameDir: string): string {
  return dataDir.slice(gameDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/** 通用 JSON-pointer 读取：root 按 segments 导航并返回叶子（非字符串或定位失败返回 null）。 */
function getByPointer(root: unknown, segments: string[]): string | null {
  let node: unknown = root;
  for (const s of segments) {
    if (node === null || typeof node !== 'object') return null;
    node = (node as Record<string, unknown>)[s];
  }
  return typeof node === 'string' ? node : null;
}

/** 通用 JSON-pointer 写入：root 按 segments 导航到叶子并赋值。 */
function setByPointer(root: unknown, segments: string[], value: string): boolean {
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[segments[i]];
  }
  if (node === null || typeof node !== 'object') return false;
  const leaf = segments[segments.length - 1];
  const rec = node as Record<string, unknown>;
  if (typeof rec[leaf] === 'string') {
    rec[leaf] = value;
    return true;
  }
  return false;
}

/** 把 entry.path 拆成 { 文件名, pointer 段数组 } */
function parsePath(path: string): { file: string; segments: string[] } | null {
  const hash = path.indexOf('#');
  if (hash < 0) return null;
  const relFile = path.slice(0, hash);
  const file = relFile.split('/').pop();
  if (!file) return null;
  const segments = path.slice(hash + 1).split('/').filter(Boolean);
  return { file, segments };
}

export const mvmzAdapter: EngineAdapter = {
  id: ENGINE_ID,
  displayName: 'RPG Maker MV / MZ',
  capabilities: {
    staticExtract: true,
    runtimeHook: true, // MV/MZ 跑在 NW.js 上，后续可加运行时 hook
    repack: true,
    cheat: true,
    mapExport: true,
    saveEdit: true,
  },

  /**
   * 声明式元数据 —— 界面靠它自适应，本文件里**不含任何界面逻辑**。
   * 加引擎 = 加一份 manifest，界面不用改（声明式配置的要求）。
   */
  manifest: {
    id: ENGINE_ID,
    displayName: 'RPG Maker MV / MZ',
    detectRules: { 特征: ['www/data/System.json', 'data/System.json', 'www/js/rpg_core.js', 'js/rmmz_core.js'] },
    translatableFields: [
      'Map*/CommonEvents/Troops 的 code 401 对白', 'Actors/Classes/Items/Skills/Weapons/Armors/States/Enemies 的 name/description/messageN',
      'System.json 的 terms 词条', 'MapInfos 的地图名',
    ],
    // 目录提示：用户最容易在这一步做错（各引擎布局不同）
    rootHint: '选含 data/ 的那一层：发布态通常是游戏根目录（里面有 www/ 与 Game.exe 的旁边那层也认）',
    sourceLanguages: [
      { id: 'ja', label: '日语 ja（最常见）' },
      { id: 'en', label: '英语 en' },
      { id: 'zh-CN', label: '简体中文 zh-CN' },
      { id: 'ko', label: '韩语 ko' },
    ],
    // 各引擎的字体机制不同，必须让用户知道"到底改了什么"
    fontOptionNote: 'MV 改 System.json 的 locale、MZ 改 advanced.fallbackFonts —— 都只是让引擎去用系统里已有的中文字体，不分发字体文件，可一键还原。',
    caveats: [
      '部分游戏的数据文件被加密（RPG Maker 的 CryptoJS 封装），加密时静态路线不可用，会被明确拒绝而不是改坏文件。',
      'MZ 的插件指令文本（code 357 里的参数）暂未覆盖。',
    ],
  },

  async detect(gameDir: string): Promise<DetectResult> {
    const dataDir = await findDataDir(gameDir);
    if (!dataDir) {
      return { matched: false, engineId: ENGINE_ID, confidence: 0 };
    }
    const notes: string[] = [`数据目录: ${relOf(dataDir, gameDir)}`];
    for (const marker of ['Game.rpgproject', 'package.json']) {
      try {
        await fs.stat(join(gameDir, marker));
        notes.push(`含 ${marker}`);
      } catch {
        /* 无 */
      }
    }

    // 关键：检查数据文件是否被游戏自己加密（CryptoJS AES）。
    // 若是，静态抽取不可用，必须明确告诉用户，而不是默默抽到 0 条。
    let encrypted = 0;
    let readable = 0;
    try {
      for (const f of await fs.readdir(dataDir)) {
        if (!f.endsWith('.json')) continue;
        try {
          const head = (await fs.readFile(join(dataDir, f), 'utf8')).slice(0, 16);
          if (looksEncryptedData(head)) encrypted++;
          else readable++;
        } catch {
          /* 忽略 */
        }
      }
    } catch {
      /* 忽略 */
    }
    if (encrypted > 0 && readable === 0) {
      notes.push(
        `⚠ 数据文件已加密（CryptoJS/OpenSSL AES，${encrypted} 个 .json）：` +
          '静态抽取不可用，需运行时提取或先解出该游戏的密钥',
      );
      notes.push('MV/MZ 具体版本未细分（宽容模式）');
      return { matched: true, engineId: ENGINE_ID, confidence: 0.6, notes };
    }
    if (encrypted > 0) notes.push(`注意：${encrypted} 个 .json 已加密被跳过，${readable} 个可读`);

    notes.push('MV/MZ 具体版本未细分（宽容模式）');
    return { matched: true, engineId: ENGINE_ID, confidence: 0.9, notes };
  },

  async *extract(gameDir: string): AsyncIterable<TextEntry> {
    const dataDir = await findDataDir(gameDir);
    if (!dataDir) return;
    const rel = relOf(dataDir, gameDir);

    // 目录清单（用于发现 Map\d+.json 与固定事件文件）
    let files: string[] = [];
    try {
      files = await fs.readdir(dataDir);
    } catch {
      return;
    }
    const jsonCache = new Map<string, unknown>();
    const load = async (file: string): Promise<unknown> => {
      if (!jsonCache.has(file)) {
        try {
          jsonCache.set(file, JSON.parse(await fs.readFile(join(dataDir, file), 'utf8')));
        } catch {
          jsonCache.set(file, undefined);
        }
      }
      return jsonCache.get(file);
    };

    // 1) 数据库字段
    for (const [file, fields] of Object.entries(DB_FIELDS)) {
      if (!files.includes(file)) continue;
      const rows = await load(file);
      if (!Array.isArray(rows)) continue;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i] as Record<string, unknown> | null;
        if (!row) continue;
        for (const field of fields) {
          const v = row[field];
          if (typeof v === 'string' && v.trim() !== '') {
            yield {
              engine: ENGINE_ID,
              path: `${rel}/${file}#/${i}/${field}`,
              key: field,
              source: v,
              status: 'pending',
            };
          }
        }
      }
    }

    // 2) System.json（菜单/界面词条：分类名、术语、系统提示）
    if (files.includes('System.json')) {
      for (const s of extractSystemText(await load('System.json'))) {
        yield {
          engine: ENGINE_ID,
          path: `${rel}/System.json#/${s.pointer.join('/')}`,
          key: s.key,
          source: s.source,
          status: 'pending',
        };
      }
    }

    // 3) 事件对白（CommonEvents / Troops / Map\d+）
    for (const file of files) {
      if (!isEventFile(file)) continue;
      const json = await load(file);
      if (json === undefined) continue;
      for (const slot of extractEventText(file, json)) {
        yield {
          engine: ENGINE_ID,
          path: `${rel}/${file}#/${slot.pointer.join('/')}`,
          key: slot.key,
          source: slot.source,
          status: 'pending',
        };
      }
    }
  },

  async repack(gameDir: string, entries: TextEntry[]): Promise<RepackResult> {
    const dataDir = await findDataDir(gameDir);
    if (!dataDir) {
      return { written: 0, unchanged: 0, skipped: 0, backupDir: '', errors: ['未找到数据目录'] };
    }

    const errors: string[] = [];
    let unchanged = 0;
    let skipped = 0;
    let toWrite = 0;
    const patchFiles: PatchFileInput[] = [];

    // 按文件分组
    const byFile = new Map<string, Array<{ segments: string[]; text: string }>>();
    for (const e of entries) {
      if (!e.translated) { skipped++; continue; }
      // 安全阀（红线）：只有 translated / reviewed 才允许写回游戏文件。
      // pending=没译、conflict=译文有缺陷（如控制符被机翻破坏），写进去会破坏游戏。
      if (e.status === 'pending' || e.status === 'conflict') { skipped++; continue; }
      const parsed = parsePath(e.path);
      if (!parsed) { skipped++; continue; }
      if (!byFile.has(parsed.file)) byFile.set(parsed.file, []);
      byFile.get(parsed.file)!.push({ segments: parsed.segments, text: e.translated });
    }

    for (const [file, list] of byFile) {
      const full = join(dataDir, file);
      let json: unknown;
      try {
        json = JSON.parse(await fs.readFile(full, 'utf8'));
      } catch (err) {
        errors.push(`读取失败 ${file}: ${(err as Error).message}`);
        continue;
      }

      // 先只做"比较"，把真正需要改的挑出来 —— 让回写**幂等**：
      // 已经是这个译文的条目直接算 unchanged，不改文件、不建备份、不误报写回量。
      let changed = 0;
      for (const c of list) {
        const cur = getByPointer(json, c.segments);
        if (cur === null) { skipped++; continue; }
        if (cur === c.text) { unchanged++; continue; }
        if (setByPointer(json, c.segments, c.text)) { changed++; toWrite++; }
        else skipped++;
      }
      if (changed === 0) continue;

      // 走通用补丁机制：备份 + 落清单 + 可一键还原（红线）
      patchFiles.push({ rel: relPath(gameDir, full), content: JSON.stringify(json) });
    }

    if (patchFiles.length === 0) {
      return { written: 0, unchanged, skipped, backupDir: '', errors };
    }
    const manifest = await applyPatch(gameDir, { label: 'repack', engine: 'mvmz', files: patchFiles });
    return { written: toWrite, unchanged, skipped, backupDir: manifest.backupDir, errors };
  },

  /** 可选能力：注入中文字体（MV 改 locale / MZ 改 fallbackFonts，零字体分发） */
  async injectCjkFont(
    gameDir: string,
    opts?: { cjkStack?: string; sampleText?: string },
  ): Promise<FontInjectOutcome> {
    const r = await injectFontImpl(gameDir, opts);
    return {
      applied: !r.alreadyApplied,
      detail: r.alreadyApplied
        ? `${r.kind}：中文字体已就绪，未产生改动`
        : `${r.kind}：已注入中文字体支持（${r.kind === 'MV' ? 'locale → zh_CN' : 'advanced.fallbackFonts'}），可一键还原`,
      notes: r.notes,
      coverage: r.coverage,
    };
  },

  /** 可选能力：还原字体注入 */
  async restoreCjkFont(gameDir: string) {
    return restoreFontImpl(gameDir);
  },
};
