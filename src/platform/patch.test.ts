import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, restoreAll, restorePatch } from './patch';

const roots: string[] = [];

async function tempGame(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'baibao-patch-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('可逆补丁', () => {
  it('按目录备份同名文件并逐字节还原', async () => {
    const game = await tempGame();
    await fs.mkdir(join(game, 'a'), { recursive: true });
    await fs.mkdir(join(game, 'b'), { recursive: true });
    await fs.writeFile(join(game, 'a', 'same.txt'), Buffer.from([0, 1, 2]));
    await fs.writeFile(join(game, 'b', 'same.txt'), Buffer.from([3, 4, 5]));

    const manifest = await applyPatch(game, {
      label: 'test',
      engine: 'test',
      files: [
        { rel: 'a/same.txt', content: 'A' },
        { rel: 'b/same.txt', content: 'B' },
      ],
    });
    expect(await fs.readFile(join(manifest.backupDir, 'files', 'a', 'same.txt'))).toEqual(Buffer.from([0, 1, 2]));
    expect(await fs.readFile(join(manifest.backupDir, 'files', 'b', 'same.txt'))).toEqual(Buffer.from([3, 4, 5]));

    const restored = await restorePatch(game, manifest);
    expect(restored.errors).toEqual([]);
    expect(await fs.readFile(join(game, 'a', 'same.txt'))).toEqual(Buffer.from([0, 1, 2]));
    expect(await fs.readFile(join(game, 'b', 'same.txt'))).toEqual(Buffer.from([3, 4, 5]));
  });

  it('拒绝绝对路径和目录穿越', async () => {
    const game = await tempGame();
    await expect(applyPatch(game, {
      label: 'bad',
      engine: 'test',
      files: [{ rel: '../outside.txt', content: 'x' }],
    })).rejects.toThrow(/非法相对路径|路径越界/);
    await expect(applyPatch(game, {
      label: 'bad',
      engine: 'test',
      files: [{ rel: '/tmp/outside.txt', content: 'x' }],
    })).rejects.toThrow(/非法相对路径|路径越界/);
  });

  it('拒绝同一补丁重复修改同一个文件', async () => {
    const game = await tempGame();
    await expect(applyPatch(game, {
      label: 'bad',
      engine: 'test',
      files: [
        { rel: 'same.txt', content: 'a' },
        { rel: './same.txt', content: 'b' },
      ],
    })).rejects.toThrow(/出现两次/);
  });

  it('拒绝通过符号链接写出游戏目录', async () => {
    const game = await tempGame();
    const outside = await tempGame();
    await fs.symlink(outside, join(game, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(applyPatch(game, {
      label: 'bad',
      engine: 'test',
      files: [{ rel: 'linked/outside.txt', content: 'x' }],
    })).rejects.toThrow(/符号链接越界/);
  });

  it('还原失败时不标记完成，允许下次重试', async () => {
    const game = await tempGame();
    await fs.writeFile(join(game, 'x.txt'), 'before');
    const manifest = await applyPatch(game, {
      label: 'test',
      engine: 'test',
      files: [{ rel: 'x.txt', content: 'after' }],
    });
    await fs.rm(join(manifest.backupDir, 'files', 'x.txt'));

    const result = await restorePatch(game, manifest);
    expect(result.errors).toHaveLength(1);
    const saved = JSON.parse(await fs.readFile(join(manifest.backupDir, 'manifest.json'), 'utf8')) as {
      restoredAt?: number;
    };
    expect(saved.restoredAt).toBeUndefined();
  });

  it('较新补丁恢复失败后停止，不继续拆除旧补丁', async () => {
    const game = await tempGame();
    const target = join(game, 'x.txt');
    await fs.writeFile(target, 'before');
    const older = await applyPatch(game, {
      label: 'older',
      engine: 'test',
      files: [{ rel: 'x.txt', content: 'middle' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await applyPatch(game, {
      label: 'newer',
      engine: 'test',
      files: [{ rel: 'x.txt', content: 'after' }],
    });
    await fs.rm(join(newer.backupDir, 'files', 'x.txt'));

    const result = await restoreAll(game);
    expect(result.patches).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(await fs.readFile(target, 'utf8')).toBe('after');

    const olderSaved = JSON.parse(
      await fs.readFile(join(older.backupDir, 'manifest.json'), 'utf8'),
    ) as { restoredAt?: number };
    expect(olderSaved.restoredAt).toBeUndefined();
  });
});
