import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TextStore } from '@platform/store/text-store';
import { TranslationMemory } from './tm';

describe('翻译记忆（TM）', () => {
  let store: TextStore;
  let tm: TranslationMemory;

  beforeEach(() => {
    store = new TextStore(':memory:');
    tm = new TranslationMemory(store);
  });
  afterEach(() => store.close());

  function seed(gameId: string, source: string, translated: string) {
    const path = `p/${source}`; // 用原文当 path，避免多条共用同一路径被互相覆盖
    store.upsert(gameId, [{ engine: 'mvmz', path, key: 'k', source, status: 'pending' }]);
    store.setTranslation(gameId, path, 'k', translated);
  }

  it('原文未变时直接复用已有译文（不送机翻）', () => {
    seed('g1', 'はい', '是');
    expect(tm.lookup('g1', 'はい')).toBe('是');
    expect(tm.lookup('g1', '不存在')).toBeUndefined();
  });

  it('本游戏命中优先于跨游戏命中', () => {
    seed('g2', 'アーサー', '阿瑟'); // g2 的人名译法
    seed('g1', 'アーサー', '亚瑟'); // g1 的人名译法
    expect(tm.lookup('g1', 'アーサー')).toBe('亚瑟'); // 本游戏优先
  });

  it('跨游戏复用：本游戏没翻过，用其它游戏的', () => {
    seed('g2', 'もちろん', '当然');
    expect(tm.lookup('g1', 'もちろん')).toBe('当然'); // g1 没有 → 复用 g2
  });

  it('批量 partition：分成已命中与需机翻', () => {
    seed('g1', 'はい', '是');
    seed('g1', 'いいえ', '不');
    const { hits, misses } = tm.partition('g1', ['はい', 'いいえ', 'まだ', 'もちろん']);
    expect(hits.size).toBe(2);
    expect(hits.get('はい')?.translated).toBe('是');
    expect(hits.get('いいえ')?.sameGame).toBe(true);
    expect(misses.sort()).toEqual(['まだ', 'もちろん']);
  });

  it('命中标记 sameGame 正确', () => {
    seed('g2', '共通句', '共通翻译');
    seed('g1', '本游句', '本游翻译');
    const { hits } = tm.partition('g1', ['共通句', '本游句']);
    expect(hits.get('本游句')?.sameGame).toBe(true);
    expect(hits.get('共通句')?.sameGame).toBe(false);
  });

  it('conflict / 未译条目不参与命中', () => {
    const path = 'p/conflict';
    store.upsert('g1', [{ engine: 'mvmz', path, key: 'k', source: '坏译文', status: 'pending' }]);
    store.setTranslation('g1', path, 'k', '被翻坏的东西', 'conflict');
    expect(tm.lookup('g1', '坏译文')).toBeUndefined();
  });
});
