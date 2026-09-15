import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPluginsArrayEnd, installMvmzBridge, uninstallMvmzBridge } from './mvmz-activator';

const roots: string[] = [];

async function fixture(): Promise<{ game: string; bridge: string; plugins: string }> {
  const root = await fs.mkdtemp(join(tmpdir(), 'baibao-runtime-'));
  roots.push(root);
  const game = join(root, 'game');
  const bridge = join(root, 'BB_RuntimeBridge.js');
  const plugins = join(game, 'www', 'js', 'plugins.js');
  await fs.mkdir(join(game, 'www', 'js', 'plugins'), { recursive: true });
  await fs.writeFile(join(game, 'www', 'js', 'rpg_core.js'), '// MV');
  await fs.writeFile(join(game, 'Game.exe'), '');
  await fs.writeFile(bridge, '// bridge');
  await fs.writeFile(
    plugins,
    'var $plugins = [\\n  {\"name\":\"A\",\"parameters\":{\"items\":[1,2]}}\\n];\\nconst tail = [9];',
  );
  return { game, bridge, plugins };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('MV/MZ 运行时桥安装', () => {
  it('只定位 $plugins 数组，不会误用文件末尾其它数组', () => {
    const src = 'var $plugins = [{\"x\":\"]\"}]; const unrelated = [1, 2];';
    const end = findPluginsArrayEnd(src);
    expect(src.slice(end, end + 2)).toBe('];');
    expect(end).toBeLessThan(src.lastIndexOf(']'));
  });

  it('忽略注释和字符串里的伪 $plugins 声明', () => {
    const src = [
      '// $plugins = ["comment"];',
      'const sample = "$plugins = [\\"string\\"]";',
      '/* $plugins = ["block"]; */',
      'var $plugins /* real */ = [{"name":"A"}];',
    ].join('\n');
    const end = findPluginsArrayEnd(src);
    expect(src.slice(end, end + 2)).toBe('];');
    expect(src.slice(0, end)).toContain('{"name":"A"}');
  });

  it('安装后可按备份逐字节还原', async () => {
    const { game, bridge, plugins } = await fixture();
    const before = await fs.readFile(plugins);
    const installed = installMvmzBridge(game, bridge);
    expect((await fs.readFile(plugins, 'utf8'))).toContain('BB_RuntimeBridge');

    const restored = uninstallMvmzBridge(game, installed.backupPath);
    expect(restored.restored).toBe(true);
    expect(await fs.readFile(plugins)).toEqual(before);
    await expect(fs.stat(join(game, 'www', 'js', 'plugins', 'BB_RuntimeBridge.js'))).rejects.toThrow();
  });

  it('同名插件即使内容相同也拒绝覆盖', async () => {
    const { game, bridge } = await fixture();
    await fs.copyFile(bridge, join(game, 'www', 'js', 'plugins', 'BB_RuntimeBridge.js'));
    expect(() => installMvmzBridge(game, bridge)).toThrow(/已存在同名插件/);
  });
});
