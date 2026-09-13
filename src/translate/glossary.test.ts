import { describe, it, expect } from 'vitest';
import {
  maskGlossary,
  unmaskGlossary,
  missingGlossaryTerms,
  normalizeGlossary,
  defaultGlossaryPh,
} from './glossary';

describe('术语表掩码/还原', () => {
  const glossary = { アーサー: '亚瑟', 伝説の剣: '传说之剑', 魔剣士: '魔剑士' };

  it('长词优先（"伝説の剣" 先于 "剣"），占位符可还原', () => {
    const entries = normalizeGlossary({ 剣: '剑', 伝説の剣: '传说之剑' });
    // 确认排序：长的在前
    expect(entries[0].source).toBe('伝説の剣');
    const { masked, map } = maskGlossary('アーサーは伝説の剣と剣を持つ', entries);
    // 伝説の剣 没被拆成 伝説の + 剣
    expect(masked).toContain(defaultGlossaryPh(0)); // 伝説の剣
    const restored = unmaskGlossary(masked, map);
    expect(restored).toBe('アーサーは传说之剑と剑を持つ'.replace('剣を', '剑を'));
  });

  it('同一术语多次出现只注册一个占位符', () => {
    const entries = normalizeGlossary(glossary);
    const { masked, map } = maskGlossary('アーサーは勇者。アーサーは王。', entries);
    const gtTerms = map.filter((m) => m.target === '亚瑟');
    expect(gtTerms).toHaveLength(1);
    expect(unmaskGlossary(masked, map)).toBe('亚瑟は勇者。亚瑟は王。');
  });

  it('占位符在机翻后会原样保留，术语逐条一致', () => {
    const entries = normalizeGlossary(glossary);
    const { masked, map } = maskGlossary('魔剣士アーサーは伝説の剣を抜く', entries);
    // 模拟机翻：只翻译非占位符部分，占位符原样
    const fakeMT = masked.replace('は', '拿着').replace('を抜く', '');
    const out = unmaskGlossary(fakeMT, map);
    expect(out).toContain('魔剑士');
    expect(out).toContain('亚瑟');
    expect(out).toContain('传说之剑');
    expect(out).not.toContain('アーサー');
    expect(out).not.toContain('魔剣士');
  });

  it('大小写敏感默认开，可关', () => {
    const cs = normalizeGlossary([{ source: 'Alice', target: '爱丽丝', caseSensitive: true }]);
    const { masked: m1 } = maskGlossary('alice and Alice', cs);
    expect(m1).toContain('alice'); // 小写不换
    const ci = normalizeGlossary([{ source: 'Alice', target: '爱丽丝', caseSensitive: false }]);
    const { masked: m2, map: m2map } = maskGlossary('alice and Alice', ci);
    expect(m2).not.toContain('alice'); // 不区分大小写，两处都替换
    expect(unmaskGlossary(m2, m2map)).toBe('爱丽丝 and 爱丽丝');
  });

  it('没有术语命中时不改动文本', () => {
    const entries = normalizeGlossary({ 不存在: 'x' });
    const { masked, map } = maskGlossary('普通文本', entries);
    expect(masked).toBe('普通文本');
    expect(map).toHaveLength(0);
  });
});

describe('术语缺失后校验', () => {
  it('检出"原文有术语但译文没有强制译法"', () => {
    const entries = normalizeGlossary({ アーサー: '亚瑟' });
    expect(missingGlossaryTerms('アーサーは勇者', '阿瑟是勇者', entries)).toEqual(['アーサー']);
    expect(missingGlossaryTerms('アーサーは勇者', '亚瑟是勇者', entries)).toEqual([]);
    expect(missingGlossaryTerms('无关的句子', '无关的翻译', entries)).toEqual([]);
  });
});
