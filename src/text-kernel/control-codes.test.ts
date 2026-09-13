import { describe, it, expect } from 'vitest';
import {
  tokenize,
  mask,
  unmask,
  missingPlaceholders,
  defaultPlaceholder,
} from './control-codes';

describe('control-codes: 无损切分', () => {
  it('tokenize 后拼回 === 原文（含混合控制符）', () => {
    const cases = [
      'こんにちは\\N[1]、元気？',
      '\\C[1]\\I[5]赤い\\C[0]薬',
      '\\{大きい\\}普通\\{さらに\\}',
      'パス\\\\tmp\\V[42]',
      'タグ<color=red>赤</color>と\\N[2]',
      '制御符なしの普通文本',
      '',
    ];
    for (const src of cases) {
      const segs = tokenize(src);
      expect(segs.map((s) => s.value).join('')).toBe(src);
    }
  });

  it('能正确识别带参/无参/符号控制符', () => {
    const segs = tokenize('\\N[1]は\\C[2]こんにちは\\C[0]\\{！\\}');
    const tokens = segs.filter((s) => s.kind === 'token').map((s) => s.value);
    expect(tokens).toEqual(['\\N[1]', '\\C[2]', '\\C[0]', '\\{', '\\}']);
  });
});

describe('control-codes: 占位与还原', () => {
  it('mask -> unmask 完整还原（round-trip）', () => {
    const cases = [
      'こんにちは\\N[1]、元気？',
      '\\C[1]\\I[5]赤い\\C[0]薬',
      '前\\V[1]中\\V[2]後',
      '変数\\V[10]とアイコン\\I[3]と色\\C[5]',
    ];
    for (const src of cases) {
      const { masked, tokens } = mask(src);
      // 占位后不应再含任何原控制符
      expect(masked).not.toMatch(/\\[A-Za-z]/);
      expect(unmask(masked, tokens)).toBe(src);
    }
  });

  it('占位符按序号替换，不会错位', () => {
    const src = 'A\\V[1]B\\V[2]C\\V[3]D';
    const { masked, tokens } = mask(src);
    expect(tokens).toEqual(['\\V[1]', '\\V[2]', '\\V[3]']);
    expect(masked).toBe(`A${defaultPlaceholder(0)}B${defaultPlaceholder(1)}C${defaultPlaceholder(2)}D`);
    expect(unmask(masked, tokens)).toBe(src);
  });
});

describe('control-codes: 质量自检', () => {
  it('占位符全部存活 → 无缺失', () => {
    const translated = `你好${defaultPlaceholder(0)}，${defaultPlaceholder(1)}怎么样`;
    expect(missingPlaceholders(translated, 2)).toEqual([]);
  });

  it('机翻翻坏占位符 → 能定位缺失序号', () => {
    // 模拟 MT 把 __BB1__ 翻没了、__BB0__ 保留
    const translated = `你好${defaultPlaceholder(0)}世界`;
    expect(missingPlaceholders(translated, 2)).toEqual([1]);
  });
});
