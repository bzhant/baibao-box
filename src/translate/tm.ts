import type { TextStore } from '@platform/store/text-store';

/**
 * 翻译记忆（TM）。
 *
 * 一句话：**原文没变的句子，直接用以前翻过的结果，不再花钱送机翻。**
 *
 * 命中规则：按原文精确匹配，优先用**本游戏**的译文（上下文一致），
 * 其次复用**其它游戏**的译文（"はい / いいえ / もちろん" 这类通用句，跨游戏复用）。
 * 控制符部分原文里就带着，所以原文相同 → 译文也必然正确。
 */

export interface TmHit {
  source: string;
  translated: string;
  /** 是否来自本游戏（否则是跨游戏复用） */
  sameGame: boolean;
}

export class TranslationMemory {
  constructor(private readonly store: TextStore) {}

  /** 单条精确匹配 */
  lookup(gameId: string, source: string): string | undefined {
    return this.store.findTranslationBySource(source, gameId);
  }

  /** 批量精确匹配（一次查完）。返回 source -> { translated, sameGame }，本游戏命中优先。 */
  lookupBatch(gameId: string, sources: readonly string[]): Map<string, TmHit> {
    const out = new Map<string, TmHit>();
    for (const [source, hit] of this.store.findTranslationsBySource(sources, gameId)) {
      out.set(source, { source, translated: hit.translated, sameGame: hit.sameGame });
    }
    return out;
  }

  /** 便捷：把一批待译条目按 TM 分成"已命中"与"需机翻"两组 */
  partition(
    gameId: string,
    sources: readonly string[],
  ): { hits: Map<string, TmHit>; misses: string[] } {
    const hits = this.lookupBatch(gameId, sources);
    const misses = sources.filter((s) => !hits.has(s));
    return { hits, misses };
  }
}
