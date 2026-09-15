import { logWarn } from '@platform/logbus';
import type { TranslationProvider } from '@shared/contracts';
import type { TranslationStore } from './translation-store';
import type { RuntimeTextItem, RuntimeTranslation, RuntimeTranslator } from './session';
import { controlCodesIntact, mask, placeholdersIntact, unmask } from '../../text-kernel/control-codes';
import { patternFor } from '../../text-kernel/patterns';

/**
 * 把"翻译能力"接到运行时取词上。
 *
 * 运行时和离线流水线用的是**同一个 Provider**（用户配置的机翻接口），
 * 区别只在触发时机：离线是"一次翻完一个游戏"，运行时是"边玩边翻当前这几句"。
 * 所以这里不重复造翻译逻辑，只加运行时才需要的东西：
 *
 *   ① **本地译文库优先** —— 已经翻过的句子直接命中，**零延迟、零费用、离线可用**
 *      （第一次翻过的句子不该再翻一遍；这也是"第二次启动瞬时"的原因）；
 *   ② **负缓存** —— 接口没给译文时记住"没有"，否则同一句每帧都会被再送一遍，
 *      玩家的钱包会被烧掉（取词是每帧触发的，这条比看起来重要）；
 *   ③ 结果回写译文库，下次直接命中。
 */

export interface ProviderTranslatorOptions {
  provider: TranslationProvider;
  /** 本地译文库（命中就完全不调接口） */
  store?: TranslationStore;
  /** 目标语言（默认 zh-CN） */
  to?: string;
  from?: string;
  /** 单批最多送几条（避免一次请求过大） */
  batchSize?: number;
  /** 每拿到一批译文回调一次（可用于落库/记日志） */
  onTranslated?: (pairs: Array<{ src: string; dst: string }>) => void;
}

export interface TranslatorStats {
  /** 命中本地译文库的次数 */
  localHits: number;
  /** 调用接口的次数 */
  calls: number;
  /** 一共送出去的条数 */
  sent: number;
  /** 其中拿到译文的条数 */
  got: number;
}

export function createProviderTranslator(o: ProviderTranslatorOptions): RuntimeTranslator {
  // 原文 → 译文；空串表示"问过了、接口给不出"，只存内存（不落盘：下次可能就翻得出来）
  const cache = new Map<string, { dst: string; retryAfter: number }>();
  const stats: TranslatorStats = { localHits: 0, calls: 0, sent: 0, got: 0 };

  const translate: RuntimeTranslator = async (items: RuntimeTextItem[], ctx) => {
    const out: RuntimeTranslation[] = [];
    const miss: RuntimeTextItem[] = [];
    for (const it of items) {
      // ① 本地译文库优先（含外部导入的字典）
      const memory = cache.get(it.src);
      const stored = o.store?.get(it.src);
      const local = memory?.dst || stored;
      if (local !== undefined) {
        if (local.length > 0) {
          cache.set(it.src, { dst: local, retryAfter: 0 });
          stats.localHits += 1;
          out.push({ src: it.src, dst: local });
          continue;
        }
      }
      if (memory && memory.retryAfter > Date.now()) {
        out.push({ src: it.src, dst: '' });
        continue;
      }
      miss.push(it);
    }

    const size = o.batchSize ?? 32;
    for (let i = 0; i < miss.length; i += size) {
      const chunk = miss.slice(i, i + size);
      const masked = chunk.map((c) => mask(c.src, patternFor('mvmz')));
      const reqs = chunk.map((_, n) => ({
        id: String(n),
        source: masked[n].masked,
        from: o.from || ctx.from || 'ja',
        to: o.to ?? 'zh-CN',
      }));

      let results: Array<{ id: string; translated: string }> = [];
      stats.calls += 1;
      stats.sent += reqs.length;
      try {
        results = await o.provider.translate(reqs);
      } catch (e) {
        logWarn('runtime', `翻译接口调用失败（这批 ${reqs.length} 条本轮放弃，稍后可重试）：${(e as Error).message}`);
      }

      const byId = new Map(results.map((r) => [r.id, r.translated]));
      const pairs: Array<{ src: string; dst: string }> = [];
      chunk.forEach((c, n) => {
        const raw = byId.get(String(n));
        const candidate = typeof raw === 'string' ? raw.trim() : '';
        const dst = placeholdersIntact(candidate, masked[n].tokens.length)
          ? unmask(candidate, masked[n].tokens)
          : '';
        if (dst.length > 0 && dst !== c.src && controlCodesIntact(c.src, dst, patternFor('mvmz'))) {
          cache.set(c.src, { dst, retryAfter: 0 });
          o.store?.set(c.src, dst); // ③ 回写译文库，下次直接命中
          pairs.push({ src: c.src, dst });
          stats.got += 1;
          out.push({ src: c.src, dst });
        } else {
          cache.set(c.src, { dst: '', retryAfter: Date.now() + 3_000 });
          out.push({ src: c.src, dst: '' });
        }
      });
      if (pairs.length > 0) o.onTranslated?.(pairs);
    }

    return out;
  };

  // 统计挂在函数上（不用改 RuntimeTranslator 的签名，也不引入额外状态）
  (translate as unknown as { stats: TranslatorStats }).stats = stats;
  return translate;
}

/** 取一份统计快照（给日志/界面用） */
export function translatorStats(t: RuntimeTranslator): TranslatorStats | null {
  return (t as unknown as { stats?: TranslatorStats }).stats ?? null;
}
