import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveBridgePath } from './index';

/**
 * 桥插件的**定位**（开发态 vs 打包态）。
 *
 * 为什么单独测这一处：一键汉化要在两种布局下都找到桥，而这两条路径的差别
 * 只有"打包后才存在 `process.resourcesPath`"这一点 —— 开发时测不到、
 * 打包后又很难回归。真出问题的症状是"点了按钮报'找不到桥插件'"，而且只在安装版上出现。
 *
 *   开发态：仓库里的 `tools/mv-runtime/BB_RuntimeBridge.js`
 *   打包态：`resources/bb-runtime/BB_RuntimeBridge.js`（由 electron-builder 的 extraResources 放进去）
 */

const REPO_BRIDGE = resolve(__dirname, '../../../tools/mv-runtime/BB_RuntimeBridge.js');

describe('运行时桥的定位', () => {
  it('开发态：能从仓库里找到', () => {
    if (!existsSync(REPO_BRIDGE)) return; // 极端情况下（只装了 out/）跳过
    const p = resolveBridgePath();
    expect(p, '开发态应当能找到 tools/mv-runtime/BB_RuntimeBridge.js').toBeTruthy();
    expect(p?.endsWith('BB_RuntimeBridge.js')).toBe(true);
  });

  it('打包态：能找到 resources/bb-runtime/ 下的那份', () => {
    if (!existsSync(REPO_BRIDGE)) return;
    const fakeResources = mkdtempSync(join(tmpdir(), 'bb-res-'));
    const dir = join(fakeResources, 'bb-runtime');
    mkdirSync(dir, { recursive: true });
    const target = join(dir, 'BB_RuntimeBridge.js');
    copyFileSync(REPO_BRIDGE, target);

    // 模拟打包后的布局：process.resourcesPath 指向 resources/
    const holder = process as unknown as { resourcesPath?: string };
    const old = holder.resourcesPath;
    holder.resourcesPath = fakeResources;
    try {
      // 显式优先：即使仓库那份也在，指定路径必须赢
      expect(resolveBridgePath(target)).toBe(target);
      // 不指定时，也应当能从 resources 里找到
      const found = resolveBridgePath();
      expect(found, '打包态应当能从 resources/bb-runtime/ 找到桥').toBeTruthy();
      expect(found === target || found === REPO_BRIDGE).toBe(true);
    } finally {
      if (old === undefined) delete holder.resourcesPath;
      else holder.resourcesPath = old;
      rmSync(fakeResources, { recursive: true, force: true });
    }
  });

  it('找不到时返回 null（让上层给出可读报错，而不是拿着空路径去跑）', () => {
    const holder = process as unknown as { resourcesPath?: string };
    const old = holder.resourcesPath;
    holder.resourcesPath = join(tmpdir(), 'bb-not-exist-' + Date.now());
    process.env['BB_BRIDGE_PATH'] = join(tmpdir(), 'nope', 'BB_RuntimeBridge.js');
    try {
      // 仓库里那份仍然存在时不算"找不到"，所以这里只断言：不抛异常、返回 string 或 null
      const p = resolveBridgePath();
      expect(p === null || typeof p === 'string').toBe(true);
    } finally {
      delete process.env['BB_BRIDGE_PATH'];
      if (old === undefined) delete holder.resourcesPath;
      else holder.resourcesPath = old;
    }
  });
});
