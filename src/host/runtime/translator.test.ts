import { describe, expect, it } from 'vitest';
import type { TranslationProvider } from '@shared/contracts';
import { createProviderTranslator, translatorStats } from './translator';
import { cachePathFor } from './translation-store';

describe('运行时翻译器', () => {
  it('不同语言方向使用独立缓存，默认方向路径保持兼容', () => {
    expect(cachePathFor('/game')).toBe(cachePathFor('/game', 'ja', 'zh-CN'));
    expect(cachePathFor('/game', 'ja', 'en')).not.toBe(cachePathFor('/game', 'ja', 'zh-CN'));
    expect(cachePathFor('/game', 'en', 'zh-CN')).not.toBe(cachePathFor('/game', 'ja', 'zh-CN'));
  });

  it('调用接口前掩码控制符，返回后无损还原', async () => {
    let sent = '';
    const provider: TranslationProvider = {
      id: 'test',
      displayName: 'test',
      async translate(reqs) {
        sent = reqs[0].source;
        return [{ id: reqs[0].id, translated: `你好${sent.match(/__BB0__/)?.[0] ?? ''}`, provider: 'test' }];
      },
    };
    const translate = createProviderTranslator({ provider });
    const out = await translate([{ src: 'こんにちは\\N[1]' }], { from: 'ja', to: 'zh-CN' });

    expect(sent).toBe('こんにちは__BB0__');
    expect(out).toEqual([{ src: 'こんにちは\\N[1]', dst: '你好\\N[1]' }]);
  });

  it('用户配置的源语言优先于桥的默认值', async () => {
    let from = '';
    const provider: TranslationProvider = {
      id: 'test',
      displayName: 'test',
      async translate(reqs) {
        from = reqs[0].from;
        return [{ id: reqs[0].id, translated: 'Translated', provider: 'test' }];
      },
    };
    const translate = createProviderTranslator({ provider, from: 'en', to: 'zh-CN' });
    await translate([{ src: 'Source' }], { from: 'ja', to: 'zh-CN' });
    expect(from).toBe('en');
  });

  it('控制符损坏时拒绝缓存，并短暂负缓存避免逐帧重试', async () => {
    let calls = 0;
    const provider: TranslationProvider = {
      id: 'bad',
      displayName: 'bad',
      async translate(reqs) {
        calls++;
        return reqs.map((r) => ({ id: r.id, translated: '坏译文', provider: 'bad' }));
      },
    };
    const translate = createProviderTranslator({ provider });
    const item = [{ src: 'こんにちは\\N[1]' }];
    expect((await translate(item, { from: 'ja', to: 'zh-CN' }))[0].dst).toBe('');
    expect((await translate(item, { from: 'ja', to: 'zh-CN' }))[0].dst).toBe('');
    expect(calls).toBe(1);
    expect(translatorStats(translate)?.got).toBe(0);
  });
});
