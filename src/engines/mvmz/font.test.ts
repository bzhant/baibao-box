import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  injectCjkFont,
  restoreCjkFont,
  checkFontStatus,
  detectMvzLayout,
  prependLocalToGameFont,
  DEFAULT_CJK_STACK,
} from './font';
import { listPatches } from '@platform/patch';

/**
 * 字体注入测试。夹具严格照**真实游戏**的结构搭：
 *  - MV：<root>/www/{js/rpg_core.js, data/System.json, fonts/gamefont.css}
 *  - MZ：<root>/{js/rmmz_core.js, data/System.json}（根布局，无 www）
 */

const MV_CSS = `@font-face {
    font-family: GameFont;
    src: url("mplus-1m-regular.ttf");
}

.IIV::-webkit-media-controls-play-button { opacity: 0; }
`;

describe('detectMvzLayout', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-font-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('识别 MV（www 布局）', async () => {
    const g = join(root, 'mv');
    await fs.mkdir(join(g, 'www', 'js'), { recursive: true });
    await fs.mkdir(join(g, 'www', 'data'), { recursive: true });
    await fs.writeFile(join(g, 'www', 'js', 'rpg_core.js'), '// mv');
    await fs.writeFile(join(g, 'www', 'data', 'System.json'), '{}');
    const l = await detectMvzLayout(g);
    expect(l?.kind).toBe('MV');
  });

  it('识别 MZ（根布局）', async () => {
    const g = join(root, 'mz');
    await fs.mkdir(join(g, 'js'), { recursive: true });
    await fs.mkdir(join(g, 'data'), { recursive: true });
    await fs.writeFile(join(g, 'js', 'rmmz_core.js'), '// mz');
    await fs.writeFile(join(g, 'data', 'System.json'), '{}');
    const l = await detectMvzLayout(g);
    expect(l?.kind).toBe('MZ');
  });

  it('非 MV/MZ 目录返回 null', async () => {
    const g = join(root, 'other');
    await fs.mkdir(g, { recursive: true });
    expect(await detectMvzLayout(g)).toBeNull();
  });
});

describe('prependLocalToGameFont', () => {
  it('把 local() 前置到 GameFont 的 src，保留原字体兜底', () => {
    const out = prependLocalToGameFont(MV_CSS);
    expect(out).toContain('local("Microsoft YaHei")');
    expect(out).toContain('local("SimHei")');
    expect(out).toContain('url("mplus-1m-regular.ttf")');
    // 原声明被替换而不是叠加
    expect(out.indexOf('local("Microsoft YaHei")')).toBeLessThan(out.indexOf('url("mplus-1m-regular.ttf")'));
  });

  it('幂等：重复调用不再改动', () => {
    const once = prependLocalToGameFont(MV_CSS);
    expect(prependLocalToGameFont(once)).toBe(once);
  });

  it('没有 GameFont 规则时原样返回', () => {
    const css = '@font-face { font-family: Other; src: url("a.ttf"); }';
    expect(prependLocalToGameFont(css)).toBe(css);
  });
});

describe('字体注入：MV', () => {
  let root: string;
  let g: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-fontmv-'));
    g = join(root, 'game');
    await fs.mkdir(join(g, 'www', 'js'), { recursive: true });
    await fs.mkdir(join(g, 'www', 'data'), { recursive: true });
    await fs.mkdir(join(g, 'www', 'fonts'), { recursive: true });
    await fs.writeFile(join(g, 'www', 'js', 'rpg_core.js'), '// mv');
    await fs.writeFile(
      join(g, 'www', 'data', 'System.json'),
      JSON.stringify({ gameTitle: 'テスト', locale: 'ja_JP', currencyUnit: '円' }),
    );
    await fs.writeFile(join(g, 'www', 'fonts', 'gamefont.css'), MV_CSS);
    await fs.writeFile(join(g, 'www', 'fonts', 'mplus-1m-regular.ttf'), 'FAKE-TTF');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('改 locale 触发引擎内置中文分支，并加固 gamefont.css', async () => {
    const r = await injectCjkFont(g);
    expect(r.kind).toBe('MV');
    expect(r.alreadyApplied).toBe(false);

    const sys = JSON.parse(await fs.readFile(join(g, 'www', 'data', 'System.json'), 'utf8'));
    expect(sys.locale).toBe('zh_CN');
    expect(sys.gameTitle).toBe('テスト'); // 其它字段不动

    const css = await fs.readFile(join(g, 'www', 'fonts', 'gamefont.css'), 'utf8');
    expect(css).toContain('local("Microsoft YaHei")');
    expect(css).toContain('url("mplus-1m-regular.ttf")');
  });

  it('不复制任何字体文件（零再分发）', async () => {
    const before = (await fs.readdir(join(g, 'www', 'fonts'))).sort();
    await injectCjkFont(g);
    const after = (await fs.readdir(join(g, 'www', 'fonts'))).sort();
    expect(after).toEqual(before);
  });

  it('重复注入是幂等的', async () => {
    await injectCjkFont(g);
    const again = await injectCjkFont(g);
    expect(again.alreadyApplied).toBe(true);
    expect(again.manifest).toBeNull();
  });

  it('生成备份与清单', async () => {
    await injectCjkFont(g);
    const patches = await listPatches(g, 'font');
    expect(patches).toHaveLength(1);
    expect(patches[0].changes.length).toBeGreaterThan(0);
    const files = await fs.readdir(join(patches[0].backupDir, 'files'));
    expect(files.length).toBeGreaterThan(0);
  });

  it('可一键还原到原始状态', async () => {
    const origSys = await fs.readFile(join(g, 'www', 'data', 'System.json'), 'utf8');
    await injectCjkFont(g);
    const res = await restoreCjkFont(g);
    expect(res?.restored).toBeGreaterThan(0);
    expect(res?.errors).toEqual([]);

    expect(await fs.readFile(join(g, 'www', 'data', 'System.json'), 'utf8')).toBe(origSys);
    expect(await fs.readFile(join(g, 'www', 'fonts', 'gamefont.css'), 'utf8')).toBe(MV_CSS);
  });
});

describe('字体注入：MZ', () => {
  let root: string;
  let g: string;
  const MZ_SYS = {
    gameTitle: 'ゲーム',
    locale: 'ja_JP',
    advanced: {
      gameId: 12345,
      mainFontFilename: 'mplus-1m-regular.woff',
      numberFontFilename: 'mplus-2p-bold-sub.woff',
      fallbackFonts: 'Verdana, sans-serif',
      fontSize: 26,
    },
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-fontmz-'));
    g = join(root, 'game');
    await fs.mkdir(join(g, 'js'), { recursive: true });
    await fs.mkdir(join(g, 'data'), { recursive: true });
    await fs.mkdir(join(g, 'fonts'), { recursive: true });
    await fs.writeFile(join(g, 'js', 'rmmz_core.js'), '// mz');
    await fs.writeFile(join(g, 'data', 'System.json'), JSON.stringify(MZ_SYS));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('只改 advanced.fallbackFonts，不动主字体文件名', async () => {
    const r = await injectCjkFont(g);
    expect(r.kind).toBe('MZ');
    const sys = JSON.parse(await fs.readFile(join(g, 'data', 'System.json'), 'utf8'));
    expect(sys.advanced.fallbackFonts).toBe(DEFAULT_CJK_STACK);
    expect(sys.advanced.fallbackFonts).toContain('Microsoft YaHei');
    // 主字体保持原样（日文字体仍然负责日文外观）
    expect(sys.advanced.mainFontFilename).toBe('mplus-1m-regular.woff');
    expect(sys.advanced.numberFontFilename).toBe('mplus-2p-bold-sub.woff');
    expect(sys.advanced.fontSize).toBe(26);
  });

  it('支持自定义字体栈', async () => {
    await injectCjkFont(g, { cjkStack: 'Noto Sans SC, sans-serif' });
    const sys = JSON.parse(await fs.readFile(join(g, 'data', 'System.json'), 'utf8'));
    expect(sys.advanced.fallbackFonts).toBe('Noto Sans SC, sans-serif');
  });

  it('checkFontStatus 反映当前状态且可还原', async () => {
    expect((await checkFontStatus(g))?.fallbackFonts).toBe('Verdana, sans-serif');
    await injectCjkFont(g);
    expect((await checkFontStatus(g))?.fallbackFonts).toBe(DEFAULT_CJK_STACK);
    await restoreCjkFont(g);
    expect((await checkFontStatus(g))?.fallbackFonts).toBe('Verdana, sans-serif');
  });
});
