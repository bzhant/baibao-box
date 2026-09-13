import type { TranslationProvider, TranslateRequest, TranslateResult } from '@shared/contracts';
import type { FetchFn } from './openai-compatible';

/**
 * 翻译 Provider：DeepL。
 *
 * 官方 REST API，批量友好（一次请求多条 text）。
 * 密钥：DEEPL_API_KEY（免费版端点 api-free.deepl.com；Pro 是 api.deepl.com，可用 baseUrl 覆盖）。
 */

export interface DeepLInit {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
}

/** DeepL 语言码：源可省略（自动识别），目标必须指定 */
function toDeepL(lang: string | undefined, isSource: boolean): string | undefined {
  if (!lang) return undefined;
  const l = lang.toLowerCase();
  if (l.startsWith('zh')) return 'ZH';
  if (l.startsWith('ja')) return 'JA';
  if (l.startsWith('en')) return isSource ? 'EN' : 'EN-US';
  if (l.startsWith('ko')) return 'KO';
  if (l.startsWith('de')) return 'DE';
  if (l.startsWith('fr')) return 'FR';
  if (l.startsWith('es')) return 'ES';
  if (l.startsWith('ru')) return 'RU';
  return l.toUpperCase();
}

export function createDeepLProvider(init: DeepLInit = {}): TranslationProvider {
  const base = (init.baseUrl ?? 'https://api-free.deepl.com').replace(/\/+$/, '');
  const fetchFn = init.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    id: 'deepl',
    displayName: 'DeepL',
    offline: false,

    async translate(reqs: TranslateRequest[]): Promise<TranslateResult[]> {
      if (reqs.length === 0) return [];
      const key = init.apiKey ?? process.env.DEEPL_API_KEY;
      if (!key) throw new Error('[deepl] 未配置 DEEPL_API_KEY');

      const body: Record<string, unknown> = {
        text: reqs.map((r) => r.source),
        target_lang: toDeepL(reqs[0]?.to, false),
      };
      const src = toDeepL(reqs[0]?.from, true);
      if (src) body.source_lang = src;

      const res = await fetchFn(`${base}/v2/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`[deepl] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const data = (await res.json()) as { translations?: Array<{ text: string }> };
      const arr = data.translations ?? [];
      return reqs.map((r, i) => ({
        id: r.id,
        translated: arr[i]?.text ?? r.source,
        provider: 'deepl',
      }));
    },
  };
}
