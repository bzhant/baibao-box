import { describe, it, expect } from 'vitest';
import { checkQuality, hasHardIssue, summarizeSoft } from './quality';

describe('译文质量自检', () => {
  it('hard：空译文', () => {
    const issues = checkQuality('こんにちは', '   ');
    expect(hasHardIssue(issues)).toBe(true);
    expect(issues[0].code).toBe('empty');
  });

  it('hard：控制符占位符缺失', () => {
    // 期望保留 2 个占位符，但译文弄丢了 1 个
    const issues = checkQuality('x', '你好__BB0__世界', { expectPlaceholders: 2 });
    expect(hasHardIssue(issues)).toBe(true);
    expect(issues.some((i) => i.code === 'placeholder-missing')).toBe(true);
  });

  it('占位符都在时不算 hard', () => {
    const issues = checkQuality('x', '你好__BB0__和__BB1__', { expectPlaceholders: 2 });
    expect(hasHardIssue(issues)).toBe(false);
  });

  it('soft：长度比离谱（日文→中文 1:1，3 倍以上可疑）', () => {
    const issues = checkQuality('こんにちは', '你好这是一个非常非常非常非常非常长的译文回答');
    expect(issues.some((i) => i.code === 'length-ratio')).toBe(true);
    // 正常长度比不应报
    const ok = checkQuality('こんにちは世界', '你好世界');
    expect(ok.some((i) => i.code === 'length-ratio')).toBe(false);
  });

  it('soft：一字不差（很可能没译）', () => {
    const issues = checkQuality('これは未翻訳かも', 'これは未翻訳かも');
    expect(issues.some((i) => i.code === 'unchanged')).toBe(true);
    // 纯数字/符号不算
    expect(checkQuality('12345', '12345').some((i) => i.code === 'unchanged')).toBe(false);
  });

  it('soft：退化重复串', () => {
    const issues = checkQuality('x', '啊啊啊啊啊啊啊啊啊啊啊');
    expect(issues.some((i) => i.code === 'repetition')).toBe(true);
    expect(checkQuality('x', '正常翻译没问题').some((i) => i.code === 'repetition')).toBe(false);
  });

  it('soft：首尾空白被吞', () => {
    const issues = checkQuality('  前面有空  ', '前面有空');
    expect(issues.some((i) => i.code === 'whitespace')).toBe(true);
    expect(checkQuality('  前面有空  ', '  前面有空  ').some((i) => i.code === 'whitespace')).toBe(false);
  });

  it('soft：术语缺失', () => {
    const issues = checkQuality('x', '译文', { glossaryMissing: ['アーサー', '伝説の剣'] });
    const gloss = issues.filter((i) => i.code === 'glossary');
    expect(gloss).toHaveLength(2);
    expect(gloss.every((i) => i.level === 'soft')).toBe(true);
  });

  it('正常译文全部通过', () => {
    const issues = checkQuality('こんにちは、__BB0__！', '你好、__BB0__！', { expectPlaceholders: 1 });
    expect(issues).toEqual([]);
  });

  it('summarizeSoft 按 code 聚合', () => {
    const issues = [
      ...checkQuality('short', 'x'.repeat(60)),
      ...checkQuality('  padded  ', 'padded'),
    ];
    const s = summarizeSoft(issues);
    expect(Object.keys(s).length).toBeGreaterThan(0);
    expect(Object.values(s).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);
  });
});
