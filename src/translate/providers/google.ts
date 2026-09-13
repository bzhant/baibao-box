import type { TranslationProvider, TranslateRequest, TranslateResult } from '@shared/contracts';
import type { FetchFn } from './openai-compatible';

/**
 * 翻译 Provider：Google 翻译（免费端点 `translate_a/single`）。
 *
 * ⚠️ 这是**非官方免费端点**：不需要密钥、无需付费，但**有被限流的风险**，
 * 且响应结构可能随 Google 调整。默认并发要压低（见流水线的 rateLimit 默认值）。
 * 需要稳定商用请换 DeepL / 官方 Cloud Translation（可 `baseUrl` 指过去）。
 */

export interface GoogleInit {
  baseUrl?: string;
  fetchFn?: FetchFn;
}

function toGoogle(lang: string | undefined): string {
  if (!lang) return 'auto';
  const l = lang.toLowerCase();
  if (l === 'zh' || l.startsWith('zh-')) return 'zh-CN';
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ko')) return 'ko';
  return l;
}

/**
 * 解析 gtx 响应。两种形态都可能出现：
 *   单 q： `[[["译文","原文",…],[后续段落…]] , …]`
 *   多 q： `[[ [ ["t1","s1"] ] , [ ["t2","s2"] ] ], …]`（每个 q 一个分组）
 */
export function parseGoogleResponse(raw: unknown, count: number): string[] {
  const out: string[] = new Array(count).fill('');
  const top = Array.isArray(raw) ? raw[0] : undefined;
  if (!Array.isArray(top)) return out;

  const grouped = Array.isArray(top[0]) && Array.isArray((top[0] as unknown[])[0]);
  const joinSegs = (segs: unknown): string =>
    Array.isArray(segs)
      ? segs.map((s) => (Array.isArray(s) ? String((s as unknown[])[0] ?? '') : '')).join('')
      : '';

  if (grouped) {
    for (let i = 0; i < count; i++) out[i] = joinSegs((top as unknown[])[i]);
    return out;
  }
  if (count === 1) out[0] = joinSegs(top);
  return out;
}

export function createGoogleProvider(init: GoogleInit = {}): TranslationProvider {
  const base = (init.baseUrl ?? 'https://translate.googleapis.com').replace(/\/+$/, '');
  const fetchFn = init.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    id: 'google',
    displayName: 'Google 翻译（免费端点）',
    offline: false,

    async translate(reqs: TranslateRequest[]): Promise<TranslateResult[]> {
      if (reqs.length === 0) return [];
      const url = new URL(`${base}/translate_a/single`);
      url.searchParams.set('client', 'gtx');
      url.searchParams.set('sl', toGoogle(reqs[0]?.from));
      url.searchParams.set('tl', toGoogle(reqs[0]?.to));
      url.searchParams.set('dt', 't');
      for (const r of reqs) url.searchParams.append('q', r.source);

      const res = await fetchFn(url.toString(), { method: 'GET' });
      if (!res.ok) throw new Error(`[google] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

      const raw = (await res.json()) as unknown;
      const parts = parseGoogleResponse(raw, reqs.length);
      return reqs.map((r, i) => ({
        id: r.id,
        translated: parts[i] || r.source,
        provider: 'google',
      }));
    },
  };
}
