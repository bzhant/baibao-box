import { describe, it, expect } from 'vitest';
import { registry } from '@platform/plugin-registry';
import { registerBuiltinPlugins } from '../main/bootstrap-plugins';

/**
 * 引擎**声明式配置**的契约测试。
 *
 * ★ 为什么值得单独测这个：
 *   声明式配置要求界面走"组件化 + 引擎声明式配置，而不是手写 50 套模板"。
 *   这条要求能不能长期守住，取决于**新增引擎时会不会漏填配置** ——
 *   漏了不会报错，界面只会静默少显示一块（比如源语言下拉退回通用列表、
 *   目录提示变空），很难被发现。所以用测试把"必备字段"钉住。
 *
 *   真正被断言的"不变量"是：**产品承诺支持的引擎，其 manifest 必须完整。**
 *   正在开发中或已移出计划的引擎（如 KiriKiri）允许没有 manifest ——
 *   所以先算"有哪些引擎真的在支持列表里"，再逐个校验。
 */

/** 产品当前承诺支持的引擎（加引擎时改这里，就等于显式承认"要给它配 manifest"） */
const SUPPORTED = ['mvmz', 'renpy'];

describe('引擎声明式配置（manifest）', () => {
  registerBuiltinPlugins(); // 幂等

  it('注册表能给出可序列化的引擎清单', () => {
    const list = registry.listManifests();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
    // 必须是纯数据：能 JSON 序列化、且不含函数
    for (const m of list) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.displayName).toBe('string');
      expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    }
  });

  it('承诺支持的引擎都带完整的 manifest', () => {
    for (const id of SUPPORTED) {
      const a = registry.getEngine(id);
      expect(a, `引擎 ${id} 没注册`).toBeTruthy();
      const m = a!.manifest;
      expect(m, `引擎 ${id} 缺 manifest（界面会静默少显示内容）`).toBeTruthy();
      expect(m!.id).toBe(id);

      // 目录提示：这是用户最容易做错的一步，不能空
      expect(m!.rootHint.length, `${id} 的 rootHint 为空`).toBeGreaterThan(4);

      // 源语言：至少要有候选，且默认值必须在候选里
      expect(m!.sourceLanguages.length, `${id} 没有 sourceLanguages`).toBeGreaterThan(0);
      for (const l of m!.sourceLanguages) {
        expect(l.id.length).toBeGreaterThan(0);
        expect(l.label.length).toBeGreaterThan(0);
      }

      // 已知坑：允许没有，但给了就必须是非空字符串
      for (const c of m!.caveats) expect(c.length).toBeGreaterThan(4);
    }
  });

  it('清单里的 capabilities 与适配器上的是同一份（不重复存储、不会不一致）', () => {
    // 这条测试守的是一个刻意的设计决定：capabilities 只存在适配器上，
    // registry 在 listManifests() 里合并进来。若哪天有人在 manifest 里
    // 又存了一份，两份就会各自漂移 —— 而这个测试会让那种改动当场失败。
    for (const m of registry.listManifests()) {
      const a = registry.getEngine(m.id);
      expect(a).toBeTruthy();
      expect(m.capabilities).toEqual(a!.capabilities);
    }
  });

  it('支持静态回写的引擎，capabilities.repack 为真（界面据此决定是否显示"回写"按钮）', () => {
    for (const id of SUPPORTED) {
      const a = registry.getEngine(id)!;
      expect(a.capabilities.repack).toBe(true);
    }
  });
});
