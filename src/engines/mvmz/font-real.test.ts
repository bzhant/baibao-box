import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectCjkFont, restoreCjkFont, checkFontStatus } from './font';

/**
 * **真实游戏样本**验证：把本机真实 MV/MZ 游戏的字体相关文件复制到临时目录，
 * 跑注入 → 断言 → 还原 → 断言逐字节还原。全程不触碰原游戏文件。
 * 若本机没有这些游戏，整组测试自动跳过（CI 友好）。
 */

/** MV 样本：原始日文游戏（未经任何汉化工具改过字体） */
const MV_SRC = process.env.BB_MV_SAMPLE ?? '__no_sample__';
/** MZ 样本：真实 MZ 游戏（根布局） */
const MZ_SRC = process.env.BB_MZ_SAMPLE ?? '__no_sample__';

const hasMv = existsSync(join(MV_SRC, 'www', 'js', 'rpg_core.js'));
const hasMz = existsSync(join(MZ_SRC, 'js', 'rmmz_core.js'));

describe.skipIf(!hasMv)('真实 MV 游戏：字体注入', () => {
  let dst: string;
  const files = ['www/js/rpg_core.js', 'www/data/System.json', 'www/fonts/gamefont.css'];

  beforeEach(async () => {
    dst = await fs.mkdtemp(join(tmpdir(), 'baibao-real-mv-'));
    for (const rel of files) {
      const src = join(MV_SRC, rel);
      if (!existsSync(src)) continue;
      await fs.mkdir(join(dst, rel, '..'), { recursive: true });
      await fs.copyFile(src, join(dst, rel));
    }
  });
  afterEach(async () => {
    await fs.rm(dst, { recursive: true, force: true });
  });

  it('真实 System.json 的 locale 不是 zh，注入后变 zh_CN', async () => {
    const before = JSON.parse(await fs.readFile(join(dst, 'www/data/System.json'), 'utf8'));
    expect(String(before.locale)).toMatch(/^ja|^en|^ko/);

    const r = await injectCjkFont(dst);
    expect(r.kind).toBe('MV');
    const after = JSON.parse(await fs.readFile(join(dst, 'www/data/System.json'), 'utf8'));
    expect(after.locale).toBe('zh_CN');
    // 除 locale 外，其它字段一个都不能丢、不能变
    for (const k of Object.keys(before)) {
      if (k === 'locale') continue;
      expect(after[k]).toEqual(before[k]);
    }
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it('真实 gamefont.css 被加上 local() 兜底，原字体保留', async () => {
    await injectCjkFont(dst);
    const css = await fs.readFile(join(dst, 'www/fonts/gamefont.css'), 'utf8');
    expect(css).toContain('local("Microsoft YaHei")');
    expect(css).toMatch(/url\(["']?mplus-1m-regular\.ttf/);
  });

  it('还原后逐字节等于原文件', async () => {
    const orig = new Map<string, Buffer>();
    for (const rel of files) {
      if (existsSync(join(dst, rel))) orig.set(rel, await fs.readFile(join(dst, rel)));
    }
    await injectCjkFont(dst);
    const res = await restoreCjkFont(dst);
    expect(res?.errors).toEqual([]);
    for (const [rel, buf] of orig) {
      expect((await fs.readFile(join(dst, rel))).equals(buf)).toBe(true);
    }
  });
});

describe.skipIf(!hasMz)('真实 MZ 游戏：字体注入', () => {
  let dst: string;
  const files = ['js/rmmz_core.js', 'data/System.json'];

  beforeEach(async () => {
    dst = await fs.mkdtemp(join(tmpdir(), 'baibao-real-mz-'));
    for (const rel of files) {
      const src = join(MZ_SRC, rel);
      if (!existsSync(src)) continue;
      await fs.mkdir(join(dst, rel, '..'), { recursive: true });
      await fs.copyFile(src, join(dst, rel));
    }
  });
  afterEach(async () => {
    await fs.rm(dst, { recursive: true, force: true });
  });

  it('真实 MZ System.json 注入 fallbackFonts，主字体名不变', async () => {
    const before = JSON.parse(await fs.readFile(join(dst, 'data/System.json'), 'utf8'));
    expect(before.advanced.mainFontFilename).toBeTruthy();

    const r = await injectCjkFont(dst);
    expect(r.kind).toBe('MZ');

    const after = JSON.parse(await fs.readFile(join(dst, 'data/System.json'), 'utf8'));
    expect(after.advanced.fallbackFonts).toContain('Microsoft YaHei');
    expect(after.advanced.mainFontFilename).toBe(before.advanced.mainFontFilename);
    expect(after.advanced.numberFontFilename).toBe(before.advanced.numberFontFilename);
    expect(Object.keys(after.advanced).sort()).toEqual(Object.keys(before.advanced).sort());
  });

  it('状态查询与还原', async () => {
    const before = JSON.parse(await fs.readFile(join(dst, 'data/System.json'), 'utf8'));
    await injectCjkFont(dst);
    expect((await checkFontStatus(dst))?.fallbackFonts).toContain('Microsoft YaHei');
    const res = await restoreCjkFont(dst);
    expect(res?.errors).toEqual([]);
    const after = JSON.parse(await fs.readFile(join(dst, 'data/System.json'), 'utf8'));
    expect(after).toEqual(before);
  });
});
