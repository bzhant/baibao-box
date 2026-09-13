import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseFontFile, readCmap, readFamilyName, missingChars } from './ttf';
import { loadSystemFonts, findFont, checkCoverage, pickCjkStack } from './index';

const SIMHEI = 'C:/Windows/Fonts/simhei.ttf';
const MSYH = 'C:/Windows/Fonts/msyh.ttc';

describe('TTF/TTC 解析', () => {
  it('非字体文件不崩', () => {
    expect(parseFontFile(Buffer.alloc(64, 7))).toEqual([]);
  });

  it.skipIf(!existsSync(SIMHEI))('SimHei：能读出真实 family 名与字符覆盖', () => {
    const buf = readFileSync(SIMHEI);
    const family = readFamilyName(buf);
    expect(family.toLowerCase()).toContain('simhei');

    const cps = readCmap(buf);
    expect(cps.size).toBeGreaterThan(10_000); // 中文字体覆盖量很大
    // 常用汉字与日文假名都该有
    for (const ch of ['你', '好', '世', '界', '汉', '字']) {
      expect(cps.has(ch.codePointAt(0)!), `缺字: ${ch}`).toBe(true);
    }
  });

  it.skipIf(!existsSync(MSYH))('.ttc 字体集合里能解析出多个 face', () => {
    const buf = readFileSync(MSYH);
    const faces = parseFontFile(buf);
    expect(faces.length).toBeGreaterThanOrEqual(1);
    expect(faces[0].codepoints.size).toBeGreaterThan(1000);
    console.log('[fonts] msyh.ttc faces:', faces.map((f) => `${f.family}#${f.index}`).join(', '));
  });

  it('missingChars 找出缺字并忽略空白', () => {
    const cps = new Set<number>([...'abc你'].map((c) => c.codePointAt(0)!));
    // 'x' 不在集合里 → 缺；空白/换行/制表符不参与判断
    expect(missingChars(cps, 'a你\n b\tx')).toEqual(['x']);
    expect(missingChars(cps, 'abc你')).toEqual([]);
    expect(missingChars(cps, '  \n\t ')).toEqual([]);
  });
});

describe.skipIf(!existsSync(SIMHEI))('系统字体与字形覆盖校验', () => {
  beforeAll(async () => {
    const faces = await loadSystemFonts();
    expect(faces.length).toBeGreaterThan(0);
  });

  it('能按 family 名找到字体（大小写不敏感）', async () => {
    const faces = await loadSystemFonts();
    expect(findFont(faces, 'SimHei')).toBeTruthy();
    expect(findFont(faces, 'simhei')).toBeTruthy();
    expect(findFont(faces, '不存在的字体名')).toBeUndefined();
  });

  it('★ MV 的中文分支（SimHei）确实能显示简体中文', async () => {
    // MV 的 standardFontFace() 在 zh 时返回 'SimHei, Heiti TC, sans-serif'
    const r = await checkCoverage('你好世界，这是一段简体中文测试。', ['SimHei', 'Heiti TC', 'sans-serif']);
    expect(r.coveredBy).not.toBeNull();
    expect(r.missing).toEqual([]);
  });

  it('★ 检出缺字：用只含拉丁字符的字体渲染中文 → 全是豆腐块', async () => {
    // 用一个几乎不含中文的字体（Arial 等）来验证能检出缺字
    const faces = await loadSystemFonts();
    const latinOnly = faces.find((f) => /arial|courier|consol/i.test(f.family) && f.codepoints.size < 2000);
    if (!latinOnly) return; // 本机没有就不强测
    const r = await checkCoverage('你好世界', [latinOnly.family]);
    expect(r.missing.length).toBeGreaterThan(0);
    expect(r.coveredBy).toBeNull();
  });

  it('字体名匹配不上时如实报告 tried 但 coveredBy=null', async () => {
    const r = await checkCoverage('你好', ['根本没有这个字体']);
    expect(r.tried).toEqual(['根本没有这个字体']);
    expect(r.coveredBy).toBeNull();
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it('★ 检出缺字：私用区字符没有任何字体收录 → 会被判为豆腐块风险', async () => {
    const r = await checkCoverage('正常汉字\uE000\uE001', ['SimHei', 'Microsoft YaHei']);
    expect(r.missing).toContain('\uE000');
    expect(r.missing).toContain('\uE001');
    expect(r.coveredBy).toBeNull();
  });

  it('pickCjkStack 能挑出真正覆盖译文的字体栈', async () => {
    const { stack, report } = await pickCjkStack('你好世界，这是一段简体中文测试。', [
      'Microsoft YaHei',
      'SimHei',
      'Noto Sans SC',
    ]);
    expect(stack.length).toBeGreaterThan(0);
    expect(report.missing).toEqual([]);
    expect(report.coveredBy).not.toBeNull();
    console.log('[fonts] 挑出的字体栈:', stack.join(', '));
  });
});
