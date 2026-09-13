import { createHash } from 'node:crypto';
import type { TranslationProvider, TranslateRequest, TranslateResult } from '@shared/contracts';
import type { FetchFn } from './openai-compatible';

/**
 * 翻译 Provider：有道智云（官方开放 API）。
 *
 * 鉴权规则（v3）：
 *   sign = md5(appKey + q + salt + curtime + appSecret)
 *   curtime = 秒级时间戳字符串；salt = 随机/us 时间戳字符串
 * 密钥：YOUDAO_APP_KEY / YOUDAO_APP_SECRET
 *
 * 注意：官方接口**一次只接受一个 q**，所以这里逐条调用（并发由流水线限流器管）。
 */

export interface YoudaoInit {
  appKey?: string;
  appSecret?: string;
  baseUrl?: string;
  fetchFn?: FetchFn;
  /** 测试可注入固定 salt/curtime，让签名可预测 */
  now?: () => number;
  saltFn?: () => string;
}

function toYoudao(lang: string | undefined, fallback: string): string {
  if (!lang) return fallback;
  const l = lang.toLowerCase();
  if (l.startsWith('zh')) return 'zh-CHS';
  if (l.startsWith('ja')) return 'ja';
  if (l.startsWith('en')) return 'en';
  if (l.startsWith('ko')) return 'ko';
  return l;
}

/** 计算 v3 签名（导出以便测试） */
export function youdaoSign(
  appKey: string,
  q: string,
  salt: string,
  curtime: string,
  appSecret: string,
): string {
  return createHash('md5').update(appKey + q + salt + curtime + appSecret, 'utf8').digest('hex');
}

export function createYoudaoProvider(init: YoudaoInit = {}): TranslationProvider {
  const base = (init.baseUrl ?? 'https://openapi.youdao.com').replace(/\/+$/, '');
  const fetchFn = init.fetchFn ?? globalThis.fetch.bind(globalThis);
  const now = init.now ?? (() => Date.now());
  const saltFn = init.saltFn ?? (() => String(now()));

  return {
    id: 'youdao',
    displayName: '有道翻译',
    offline: false,

    async translate(reqs: TranslateRequest[]): Promise<TranslateResult[]> {
      if (reqs.length === 0) return [];
      const appKey = init.appKey ?? process.env.YOUDAO_APP_KEY;
      const appSecret = init.appSecret ?? process.env.YOUDAO_APP_SECRET;
      if (!appKey || !appSecret) {
        throw new Error('[youdao] 未配置 YOUDAO_APP_KEY / YOUDAO_APP_SECRET');
      }

      const out: TranslateResult[] = [];
      for (const r of reqs) {
        const salt = saltFn();
        const curtime = String(Math.floor(now() / 1000));
        const form = new URLSearchParams({
          q: r.source,
          from: toYoudao(r.from, 'auto'),
          to: toYoudao(r.to, 'zh-CHS'),
          appKey,
          salt,
          curtime,
          sign: youdaoSign(appKey, r.source, salt, curtime, appSecret),
          signType: 'v3',
        });

        const res = await fetchFn(`${base}/api`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
        });
        if (!res.ok) throw new Error(`[youdao] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

        const data = (await res.json()) as { translation?: string[]; errorCode?: string };
        if (data.errorCode && data.errorCode !== '0') {
          throw new Error(`[youdao] errorCode=${data.errorCode}`);
        }
        out.push({
          id: r.id,
          translated: (data.translation ?? []).join('\n') || r.source,
          provider: 'youdao',
        });
      }
      return out;
    },
  };
}
