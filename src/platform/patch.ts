import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, relative, sep, isAbsolute, normalize, resolve, basename } from 'node:path';

/**
 * 通用"打补丁"机制：**先备份、留清单、可一键还原**。
 *
 * 红线：任何对游戏文件的修改都必须先备份且可逆。
 * 字体注入、静态回写、兼容性修复都走这一套，不要各写各的。
 *
 * **按字节处理**：内容可以是 string（按 UTF-8）或 Buffer。
 * 这一点很关键 —— 老 galgame 脚本常是 Shift-JIS / EUC-JP，
 * 若一律按字符串 + UTF-8 写盘会把文件写坏（Node 的 TextEncoder 也只输出 UTF-8）。
 *
 * 目录约定：`<gameDir>/.baibao-backup/<时间戳>/`
 *   ├─ manifest.json          改动清单
 *   └─ files/<相对路径>        原始文件副本（按字节，还原用）
 */

export interface PatchFileInput {
  /** 相对游戏根的路径，如 `www/data/System.json` */
  rel: string;
  /** 修改后的完整内容；Buffer 用于非 UTF-8 文件 */
  content: string | Buffer;
}

export interface PatchChange {
  rel: string;
  /** 修改前该文件是否存在 */
  existed: boolean;
  /** 修改前后字节数（用于报告与自检） */
  bytesBefore: number;
  bytesAfter: number;
}

export interface PatchManifest {
  version: 1;
  label: string;
  engine: string;
  appliedAt: number;
  backupDir: string;
  changes: PatchChange[];
  restoredAt?: number;
}

const BACKUP_ROOT = '.baibao-backup';

function stamp(): string {
  return `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
}

function safeName(rel: string): string {
  return rel.split(/[\\/]/g).join('__');
}

const toBuffer = (c: string | Buffer): Buffer =>
  typeof c === 'string' ? Buffer.from(c, 'utf8') : c;

function safeRel(rel: string): string {
  const clean = normalize(rel).split(sep).join('/');
  if (!clean || clean === '.' || isAbsolute(rel) || clean === '..' || clean.startsWith('../') || clean.includes('\0')) {
    throw new Error(`[patch] 非法相对路径：${rel}`);
  }
  return clean;
}

function targetPath(gameDir: string, rel: string): string {
  const root = resolve(gameDir);
  const target = resolve(root, safeRel(rel));
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error(`[patch] 路径越界：${rel}`);
  return target;
}

function targetKey(gameDir: string, rel: string): string {
  const target = targetPath(gameDir, rel);
  if (process.platform !== 'win32') return target;
  return target
    .split(sep)
    .map((part) => part.replace(/[ .]+$/g, '').toLowerCase())
    .join(sep);
}

async function assertContained(gameDir: string, target: string): Promise<void> {
  const root = await fs.realpath(resolve(gameDir));
  let probe = resolve(target);
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== root && !real.startsWith(`${root}${sep}`)) {
        throw new Error(`[patch] 路径经过符号链接越界：${target}`);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const parent = dirname(probe);
      if (parent === probe) throw e;
      probe = parent;
    }
  }
}

/**
 * 应用补丁：写文件 + 备份原文件 + 落清单。
 * 任何一步失败都不会留下"改了一半"的状态（已写文件会回滚）。
 */
export async function applyPatch(
  gameDir: string,
  opts: { label: string; engine: string; files: readonly PatchFileInput[] },
): Promise<PatchManifest> {
  const seen = new Set<string>();
  const inputs = opts.files.map((file) => {
    const rel = safeRel(file.rel);
    const key = targetKey(gameDir, rel);
    if (seen.has(key)) throw new Error(`[patch] 同一个文件不能在一次补丁中出现两次：${rel}`);
    seen.add(key);
    return { ...file, rel };
  });
  const backupDir = join(gameDir, BACKUP_ROOT, stamp());
  const filesDir = join(backupDir, 'files');
  await assertContained(gameDir, filesDir);
  await fs.mkdir(filesDir, { recursive: true });

  const changes: PatchChange[] = [];

  try {
    for (const f of inputs) {
      const rel = f.rel;
      const abs = targetPath(gameDir, rel);
      await assertContained(gameDir, abs);
      const next = toBuffer(f.content);

      let prev: Buffer | null = null;
      try {
        prev = await fs.readFile(abs);
      } catch {
        prev = null; // 原先不存在
      }
      if (prev && prev.equals(next)) continue; // 无需改动

      // 红线：改之前先备份原始字节
      if (prev) {
        const backup = join(filesDir, rel);
        await fs.mkdir(dirname(backup), { recursive: true });
        await fs.writeFile(backup, prev);
      }

      await fs.mkdir(dirname(abs), { recursive: true });
      changes.push({
        rel,
        existed: prev !== null,
        bytesBefore: prev ? prev.length : 0,
        bytesAfter: next.length,
      });
      await fs.writeFile(abs, next);
    }
    const manifest: PatchManifest = {
      version: 1,
      label: opts.label,
      engine: opts.engine,
      appliedAt: Date.now(),
      backupDir,
      changes,
    };
    await fs.writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return manifest;
  } catch (err) {
    // 回滚：有备份的写回，没备份的删掉
    for (const c of changes) {
      const abs = targetPath(gameDir, c.rel);
      const nested = join(filesDir, c.rel);
      const legacy = join(filesDir, safeName(c.rel));
      try {
        if (c.existed) await fs.copyFile(await exists(nested) ? nested : legacy, abs);
        else await fs.rm(abs, { force: true });
      } catch {
        /* 尽力而为 */
      }
    }
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`[patch] 应用失败已回滚: ${(err as Error).message}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

/** 列出某游戏的所有补丁（按时间倒序） */
export async function listPatches(gameDir: string, label?: string): Promise<PatchManifest[]> {
  const root = join(gameDir, BACKUP_ROOT);
  let dirs: string[] = [];
  try {
    dirs = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: PatchManifest[] = [];
  for (const d of dirs) {
    try {
      const m = JSON.parse(await fs.readFile(join(root, d, 'manifest.json'), 'utf8')) as PatchManifest;
      if (!label || m.label === label) out.push(m);
    } catch {
      /* 跳过无效目录 */
    }
  }
  return out.sort((a, b) => b.appliedAt - a.appliedAt);
}

/** 按清单还原：有备份的按字节写回，原先不存在则删除。 */
export async function restorePatch(
  gameDir: string,
  manifest: PatchManifest,
): Promise<{ restored: number; errors: string[] }> {
  const backupDir = join(resolve(gameDir), BACKUP_ROOT, basename(manifest.backupDir));
  await assertContained(gameDir, backupDir);
  const filesDir = join(backupDir, 'files');
  const errors: string[] = [];
  let restored = 0;

  for (const c of manifest.changes) {
    try {
      const abs = targetPath(gameDir, c.rel);
      await assertContained(gameDir, abs);
      const nested = join(filesDir, safeRel(c.rel));
      const legacy = join(filesDir, safeName(c.rel));
      if (c.existed) {
        await fs.mkdir(dirname(abs), { recursive: true });
        await fs.copyFile(await exists(nested) ? nested : legacy, abs); // 兼容旧版平铺备份
      } else {
        await fs.rm(abs, { force: true });
      }
      restored++;
    } catch (err) {
      errors.push(`${c.rel}: ${(err as Error).message}`);
    }
  }

  if (errors.length === 0) {
    manifest.restoredAt = Date.now();
    await fs
      .writeFile(join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
      .catch(() => {});
  }
  return { restored, errors };
}

/** 还原最近一次某类补丁 */
export async function restoreLatest(gameDir: string, label: string) {
  const [latest] = await listPatches(gameDir, label);
  if (!latest) return null;
  return restorePatch(gameDir, latest);
}

/**
 * 还原**全部未还原**的补丁，按时间**倒序**展开（新→旧）。
 *
 * 顺序很关键：多个补丁可能改同一个文件（比如回写和字体注入都会动 System.json）。
 * 必须从最新的往回剥，才能一层层还原到原始状态。
 */
export async function restoreAll(
  gameDir: string,
): Promise<{ restored: number; errors: string[]; patches: number }> {
  const all = (await listPatches(gameDir)).filter((p) => !p.restoredAt); // listPatches 已倒序
  const out = { restored: 0, errors: [] as string[], patches: 0 };
  for (const m of all) {
    const r = await restorePatch(gameDir, m);
    out.restored += r.restored;
    out.errors.push(...r.errors);
    out.patches++;
    if (r.errors.length > 0) break;
  }
  return out;
}

/** 读取备份里的原始字节（供调试/对比） */
export async function readBackupFile(
  manifest: PatchManifest,
  rel: string,
): Promise<Buffer | null> {
  try {
    const nested = join(manifest.backupDir, 'files', safeRel(rel));
    const legacy = join(manifest.backupDir, 'files', safeName(rel));
    return await fs.readFile(await exists(nested) ? nested : legacy);
  } catch {
    return null;
  }
}

/** 相对路径工具（统一成 / 分隔） */
export function relPath(gameDir: string, abs: string): string {
  return relative(gameDir, abs).split(sep).join('/');
}
