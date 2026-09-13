import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  EngineAdapter,
  DetectResult,
  TextEntry,
  RepackResult,
} from '@shared/contracts';
import { extractRpySlots, replaceRpyLiteral } from './rpy-parse';
import { applyPatch, relPath, type PatchFileInput } from '@platform/patch';

/**
 * 引擎适配器：Ren'Py（P1）。
 *
 * 路线：**静态解析 `.rpy` 脚本**，无需注入。
 *  - 识别 narration（旁白）/ say（角色对白）/ choice（菜单选项）/ name（角色显示名）/ extend
 *  - 字符串转义、注释、多字符串行都交给 `rpy-parse.ts` 的字符串感知扫描器
 *
 * 本适配器**跳过** `tl/`（那是官方翻译目录，不是原文）、`saves/`、`cache/`、`renpy/`。
 *
 * 已知边界（待补）：
 *  - `.rpa` 归档内的脚本：需先解包（Ren'Py 的 RPA 格式）
 *  - `.rpyc`（编译后的 Python 字节码）：不做反编译，只处理 `.rpy`
 *  - 跨行 `"""…"""` 大段文本：保守跳过
 */

const ENGINE_ID = 'renpy';

const SKIP_DIRS = new Set(['tl', 'saves', 'cache', 'renpy', '.git', 'python-packages']);

/** 找游戏根：`<dir>/game` 或 `<dir>` 本身 */
async function findGameRoot(dir: string): Promise<{ root: string; gameDir: string } | null> {
  for (const [root, gd] of [
    [dir, join(dir, 'game')],
    [dir, dir],
  ] as const) {
    try {
      const st = await fs.stat(gd);
      if (!st.isDirectory()) continue;
      const files = await fs.readdir(gd);
      if (files.some((f) => f.endsWith('.rpy') || f.endsWith('.rpyc'))) {
        return { root, gameDir: gd };
      }
    } catch {
      /* 不存在则继续 */
    }
  }
  return null;
}

/** 递归收集 gameDir 下的 .rpy（跳过 SKIP_DIRS） */
async function collectRpy(gameDir: string, current = gameDir, out: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(current, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await collectRpy(gameDir, full, out);
    } else if (e.isFile() && e.name.endsWith('.rpy')) {
      out.push(full);
    }
  }
  return out;
}

/** 读 Ren'Py 版本（renpy/vc_version.py 里的 `version = (8, 1, 3)`） */
async function readVersion(dir: string): Promise<string | undefined> {
  for (const p of [join(dir, 'renpy', 'vc_version.py'), join(dir, '..', 'renpy', 'vc_version.py')]) {
    try {
      const txt = await fs.readFile(p, 'utf8');
      const m = txt.match(/version\s*=\s*\(([^)]*)\)/);
      if (m) {
        const nums = m[1].split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
        if (nums.length) return `Ren'Py ${nums.join('.')}`;
      }
    } catch {
      /* 无 */
    }
  }
  return undefined;
}

function toPathKey(gameDir: string, file: string): string {
  return relative(gameDir, file).split(sep).join('/');
}

/** 解析 entry.path -> { 文件键, 行号, 序号 } */
function parsePath(path: string): { file: string; line: number; ordinal: number } | null {
  const hash = path.indexOf('#');
  if (hash < 0) return null;
  const file = path.slice(0, hash);
  const m = path.slice(hash + 1).match(/^\/L(\d+)\/(\d+)$/);
  if (!m) return null;
  return { file, line: Number(m[1]), ordinal: Number(m[2]) };
}

export const renpyAdapter: EngineAdapter = {
  id: ENGINE_ID,
  displayName: "Ren'Py",
  capabilities: {
    staticExtract: true,
    runtimeHook: true, // 后续可加 PythonHook 运行时兜底
    repack: true,
    cheat: true,
    mapExport: false,
    saveEdit: true,
  },

  /**
   * 声明式元数据 —— 界面靠它自适应，本文件里**不含任何界面逻辑**。
   *
   * ★ Ren'Py 这一份特别值得看：它的"折行"是引擎自带的
   *   （`renpy/text/text.py` 里 unicode/eastasian 就是 CJK 断行），
   *   所以它的 caveats 里写的是"**不要**自己写折行插件"——
   *   这种"引擎特性"只有引擎自己知道，正是 manifest 该承载的东西。
   */
  manifest: {
    id: ENGINE_ID,
    displayName: "Ren'Py",
    detectRules: { 特征: ['game/*.rpy', 'game/*.rpyc', 'renpy/vc_version.py', 'lib/py3-*'] },
    translatableFields: [
      'say（旁白/对白）', 'menu（选项）', 'define 字符串（角色名等）', 'extend',
    ],
    rootHint: '选含 game/ 的那一层：游戏根目录（里面有 .exe、renpy/ 与 game/）',
    sourceLanguages: [
      { id: 'ja', label: '日语 ja（最常见）' },
      { id: 'en', label: '英语 en' },
      { id: 'zh-CN', label: '简体中文 zh-CN' },
    ],
    fontOptionNote: "用 FontGroup 给 CJK 加字体回退（保留游戏原有装饰字体），并允许按名字使用系统字体 —— 同样不分发字体文件。",
    caveats: [
      "Ren'Py 自带专业排版引擎与 CJK 断行（style 的 language 属性），不需要额外的折行处理。",
      '.rpa 归档内的脚本暂不支持（需先解包）；.rpyc 是编译产物，不处理。',
      '游戏可能装了自定义界面脚本，改动前会自动备份、可一键还原。',
    ],
  },

  async detect(gameDir: string): Promise<DetectResult> {
    const found = await findGameRoot(gameDir);
    if (!found) return { matched: false, engineId: ENGINE_ID, confidence: 0 };

    const notes: string[] = [`脚本目录: ${toPathKey(gameDir, found.gameDir) || '.'}`];
    const version = await readVersion(found.root);
    if (version) notes.push(`版本: ${version}`);

    const rpy = await collectRpy(found.gameDir);
    notes.push(`.rpy 文件数: ${rpy.length}`);
    if (rpy.length === 0) {
      notes.push('仅有 .rpyc，暂不支持（需先解包/反编译）');
      return { matched: true, engineId: ENGINE_ID, version, confidence: 0.5, notes };
    }
    return { matched: true, engineId: ENGINE_ID, version, confidence: 0.9, notes };
  },

  async *extract(gameDir: string): AsyncIterable<TextEntry> {
    const found = await findGameRoot(gameDir);
    if (!found) return;
    const files = await collectRpy(found.gameDir);

    for (const file of files) {
      let text: string;
      try {
        text = await fs.readFile(file, 'utf8');
      } catch {
        continue;
      }
      const key = toPathKey(found.gameDir, file);
      for (const slot of extractRpySlots(text)) {
        if (!slot.source.trim()) continue;
        yield {
          engine: ENGINE_ID,
          path: `${key}#/L${slot.line}/${slot.ordinal}`,
          key: slot.kind,
          source: slot.source,
          status: 'pending',
          context: slot.kind === 'name' ? '角色显示名' : undefined,
        };
      }
    }
  },

  async repack(gameDir: string, entries: TextEntry[]): Promise<RepackResult> {
    const found = await findGameRoot(gameDir);
    if (!found) {
      return { written: 0, unchanged: 0, skipped: 0, backupDir: '', errors: ["未找到 Ren'Py 脚本目录"] };
    }

    const errors: string[] = [];
    let unchanged = 0;
    let skipped = 0;
    let toWrite = 0;
    const patchFiles: PatchFileInput[] = [];

    const byFile = new Map<string, Array<{ line: number; ordinal: number; text: string }>>();
    for (const e of entries) {
      if (!e.translated) { skipped++; continue; }
      // 安全阀（红线）：只有 translated / reviewed 才允许写回游戏文件。
      if (e.status === 'pending' || e.status === 'conflict') { skipped++; continue; }
      const p = parsePath(e.path);
      if (!p) { skipped++; continue; }
      if (!byFile.has(p.file)) byFile.set(p.file, []);
      byFile.get(p.file)!.push({ line: p.line, ordinal: p.ordinal, text: e.translated });
    }

    for (const [fileKey, list] of byFile) {
      const full = join(found.gameDir, fileKey);
      let text: string;
      try {
        text = await fs.readFile(full, 'utf8');
      } catch (err) {
        errors.push(`读取失败 ${fileKey}: ${(err as Error).message}`);
        continue;
      }

      const lines = text.split(/\r?\n/);
      let changed = 0;
      for (const { line, ordinal, text: tr } of list) {
        const idx = line - 1;
        if (idx < 0 || idx >= lines.length) { skipped++; continue; }
        const next = replaceRpyLiteral(lines[idx], ordinal, tr);
        if (next === null) { skipped++; continue; }
        // 幂等：内容已经一致就不改、不备份、不计入写回量
        if (next === lines[idx]) { unchanged++; continue; }
        lines[idx] = next;
        changed++;
        toWrite++;
      }
      if (changed === 0) continue;

      // 走通用补丁机制：备份 + 落清单 + 可一键还原（红线）
      patchFiles.push({ rel: relPath(gameDir, full), content: lines.join('\n') });
    }

    if (patchFiles.length === 0) {
      return { written: 0, unchanged, skipped, backupDir: '', errors };
    }
    const manifest = await applyPatch(gameDir, { label: 'repack', engine: 'renpy', files: patchFiles });
    return { written: toWrite, unchanged, skipped, backupDir: manifest.backupDir, errors };
  },
};
