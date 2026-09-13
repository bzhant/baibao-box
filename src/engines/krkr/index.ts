import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type {
  EngineAdapter,
  DetectResult,
  TextEntry,
  RepackResult,
} from '@shared/contracts';
import { applyPatch, relPath, type PatchFileInput } from '@platform/patch';
import { decodeKs, encodeKs, extractKsText, replaceKsSegment } from './ks-parse';

/**
 * KiriKiri 2 / Z 适配器（静态路线）。
 *
 * ⚠️ 诚实说明：本适配器**尚未在真实 KiriKiri 游戏上验证过**
 * （本机游戏库里的两个 KiriKiri 样本已被删除，见 `tools/_gamelib.txt`）。
 * 实现依据是 `.ks` 的文本结构，并刻意采用**保守策略**：
 *   - 只翻译"文本段"，注释 / 标签 / `*label` / `@命令` / `[...]` 内联标签**全部原样保留**；
 *   - 不认识的构造一律穿透，回写时逐字节还原；
 *   - 因此即使标签知识不全，也不会破坏脚本（顶多是漏翻，不会翻坏）。
 * 拿到真样本后应补一轮实测并扩充标签白名单。
 *
 * 覆盖范围：`.ks` 场景脚本（对白主体）。
 * 未覆盖：`.scn`（编译后的 .ks，二进制）、`.tjs`（TJS 脚本，字符串提取待做）。
 */

const ENGINE_ID = 'krkr';

const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', '.git', '.baibao-backup', 'save', 'saves']);

interface ScanResult {
  ks: string[];
  tjs: string[];
  scn: string[];
}

/** 扫描游戏目录里的 KiriKiri 脚本（相对路径，/ 分隔） */
async function scanScripts(gameDir: string, maxDepth = MAX_DEPTH): Promise<ScanResult> {
  const out: ScanResult = { ks: [], tjs: [], scn: [] };
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let items: string[] = [];
    try {
      items = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = await fs.stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const lower = name.toLowerCase();
      const rel = relative(gameDir, full).split(sep).join('/');
      if (lower.endsWith('.ks')) out.ks.push(rel);
      else if (lower.endsWith('.tjs')) out.tjs.push(rel);
      else if (lower.endsWith('.scn')) out.scn.push(rel);
    }
  };
  await walk(gameDir, 0);
  out.ks.sort();
  out.tjs.sort();
  out.scn.sort();
  return out;
}

/** `<相对路径>#L<行号>:<段号>` */
function makePath(file: string, line: number, ordinal: number): string {
  return `${file}#L${line}:${ordinal}`;
}

function parsePath(p: string): { file: string; line: number; ordinal: number } | null {
  const m = /^(.*)#L(\d+):(\d+)$/.exec(p);
  if (!m) return null;
  return { file: m[1], line: Number(m[2]), ordinal: Number(m[3]) };
}

export const krkrAdapter: EngineAdapter = {
  id: ENGINE_ID,
  displayName: 'KiriKiri 2 / Z',

  async detect(gameDir: string): Promise<DetectResult> {
    const { ks, tjs, scn } = await scanScripts(gameDir);
    if (ks.length === 0 && tjs.length === 0 && scn.length === 0) {
      return { matched: false, engineId: ENGINE_ID, confidence: 0 };
    }

    const notes: string[] = [`场景脚本: ${ks.length} 个 .ks`];
    if (tjs.length > 0) notes.push(`TJS 脚本: ${tjs.length} 个 .tjs（暂不抽取文本）`);
    if (scn.length > 0) {
      notes.push(
        `⚠ 有 ${scn.length} 个 .scn（编译后的脚本，二进制）：暂不支持静态抽取，` +
          '需运行时提取或先解包成 .ks',
      );
    }
    if (ks.length === 0) {
      notes.push('⚠ 没有 .ks：只有编译脚本，静态抽取不可用');
      return { matched: true, engineId: ENGINE_ID, confidence: 0.4, notes };
    }
    notes.push('版本未细分（宽容模式）');
    notes.push('⚠ 本适配器尚未在真实 KiriKiri 游戏上验证过，结果请人工核对后再使用');
    return { matched: true, engineId: ENGINE_ID, confidence: 0.85, notes };
  },

  async *extract(gameDir: string): AsyncIterable<TextEntry> {
    const { ks } = await scanScripts(gameDir);
    for (const rel of ks) {
      const full = join(gameDir, rel);
      let buf: Buffer;
      try {
        buf = await fs.readFile(full);
      } catch {
        continue;
      }
      const { text } = decodeKs(buf);
      for (const slot of extractKsText(text)) {
        yield {
          engine: ENGINE_ID,
          path: makePath(rel, slot.line, slot.ordinal),
          key: 'msg',
          source: slot.source,
          status: 'pending',
        };
      }
    }
  },

  async repack(gameDir: string, entries: TextEntry[]): Promise<RepackResult> {
    const errors: string[] = [];
    const notes: string[] = [];
    let unchanged = 0;
    let skipped = 0;
    let toWrite = 0;
    const patchFiles: PatchFileInput[] = [];

    // 按文件分组
    const byFile = new Map<string, Array<{ line: number; ordinal: number; text: string }>>();
    for (const e of entries) {
      if (!e.translated) {
        skipped++;
        continue;
      }
      // 安全阀（红线）：只有 translated / reviewed 才允许写回
      if (e.status === 'pending' || e.status === 'conflict') {
        skipped++;
        continue;
      }
      const p = parsePath(e.path);
      if (!p) {
        skipped++;
        continue;
      }
      if (!byFile.has(p.file)) byFile.set(p.file, []);
      byFile.get(p.file)!.push({ line: p.line, ordinal: p.ordinal, text: e.translated });
    }

    for (const [file, list] of byFile) {
      const full = join(gameDir, file);
      let buf: Buffer;
      try {
        buf = await fs.readFile(full);
      } catch (err) {
        errors.push(`读取失败 ${file}: ${(err as Error).message}`);
        continue;
      }
      const { text, encoding } = decodeKs(buf);

      // 按 '\n' 切分并保留行尾 '\r'（在替换函数里处理），保证 EOL 原样
      const lines = text.split('\n');
      let changed = 0;
      for (const c of list) {
        const idx = c.line - 1;
        if (idx < 0 || idx >= lines.length) {
          skipped++;
          continue;
        }
        const next = replaceKsSegment(lines[idx], c.ordinal, c.text);
        if (next === null) {
          skipped++;
          continue;
        }
        if (next === lines[idx]) {
          unchanged++; // 幂等：已经是目标值
          continue;
        }
        lines[idx] = next;
        changed++;
        toWrite++;
      }
      if (changed === 0) continue;

      try {
        // 按原编码编码回字节；补丁机制按字节处理，Shift-JIS 等不会被写坏
        let { buf, lossy } = await encodeKs(lines.join('\n'), encoding);
        if (lossy) {
          // Shift-JIS 装不下简体中文：iconv 会静默变成 ?，必须降级到 UTF-8 with BOM
          const fallback = await encodeKs(lines.join('\n'), 'utf-8-bom');
          buf = fallback.buf;
          notes.push(
            `⚠ ${file}：原编码 ${encoding} 无法表示译文（如简体中文），已改用 UTF-8 with BOM 保存。` +
              '若游戏读取乱码，需要在游戏侧把脚本编码设为 UTF-8。',
          );
        }
        patchFiles.push({ rel: relPath(gameDir, full), content: buf });
      } catch (err) {
        errors.push(`编码失败 ${file}: ${(err as Error).message}`);
      }
    }

    if (patchFiles.length === 0) {
      return { written: 0, unchanged, skipped, backupDir: '', errors, notes };
    }
    const manifest = await applyPatch(gameDir, {
      label: 'repack',
      engine: ENGINE_ID,
      files: patchFiles,
    });
    return { written: toWrite, unchanged, skipped, backupDir: manifest.backupDir, errors, notes };
  },

  capabilities: {
    staticExtract: true,
    runtimeHook: true, // 后续可加 krkr2/krkrz hook 兜底
    repack: true,
    cheat: false,
    mapExport: false,
    saveEdit: false,
  },
};
