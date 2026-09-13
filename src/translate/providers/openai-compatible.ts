import type {
  TranslationProvider,
  TranslateRequest,
  TranslateResult,
} from '@shared/contracts';

/**
 * OpenAI 兼容接口工厂。
 *
 * 兼容一切 OpenAI 风格的 chat/completions 端点：官方、LM Studio、Ollama、各种网关。
 * 被 `openai.ts`（云端）和 `local-llm.ts`（本地）共用。
 */

export interface OpenAICompatibleInit {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** 本地模型标 true（离线可用，不上云） */
  offline?: boolean;
  /** 注入自定义 fetch（测试用）；默认全局 fetch */
  fetchFn?: typeof fetch;
  /** 批量时的请求并发由调用方控制；这里只管构造与解析 */
}

export type FetchFn = typeof fetch;

/** 把一批请求拼成一次调用（减少往返）。控制符已被 text-kernel 掩码。 */
export function buildBatchPrompt(reqs: readonly TranslateRequest[]): string {
  const lines = reqs.map((r, i) => {
    const ctx = r.context ? `（上下文：${r.context}）` : '';
    const gloss = r.glossary && Object.keys(r.glossary).length
      ? `（术语：${Object.entries(r.glossary).map(([k, v]) => `${k}=${v}`).join('，')}）`
      : '';
    return `[${i}] ${r.source}${ctx}${gloss}`;
  });
  return [
    `你是游戏本地化翻译。把下面每行从 ${reqs[0]?.from ?? '源语言'} 翻译成 ${reqs[0]?.to ?? '目标语言'}。`,
    '规则：',
    '1. __BB数字__ / __GT数字__ 这类占位符必须**原样保留**，一个都不能丢、不能改、不能翻译；',
    '2. 只输出译文，每行以 [序号] 开头，行数与输入一致；',
    '3. 不要解释、不要加引号包裹整句、保持原有换行与空白；',
    '4. 有（上下文：…）时用它判断语气/人称，但**不要翻译也不要输出**这部分；',
    '5. 有（术语：…）时，务必使用给出的译法。',
    ...lines,
  ].join('\n');
}

/** 从模型回复里按 [序号] 拆回各条译文 */
export function parseBatchReply(text: string, count: number): string[] {
  const out: string[] = new Array(count).fill('');
  const re = /\[(\d+)\]\s*(.+?)(?=\n\[\d+\]|$)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const i = Number(m[1]);
    if (i >= 0 && i < count) out[i] = m[2].trim();
  }
  return out;
}

export function createOpenAICompatibleProvider(init: OpenAICompatibleInit = {}): TranslationProvider {
  const id = init.id ?? 'openai';
  const displayName = init.displayName ?? 'OpenAI 兼容接口';
  const baseUrl = (init.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = init.model ?? 'gpt-4o-mini';
  const fetchFn = init.fetchFn ?? globalThis.fetch.bind(globalThis);

  return {
    id,
    displayName,
    offline: init.offline ?? false,

    async translate(reqs: TranslateRequest[]): Promise<TranslateResult[]> {
      if (reqs.length === 0) return [];
      const apiKey = init.apiKey ?? process.env.BAIBAO_OPENAI_API_KEY;
      if (!init.offline && !apiKey) {
        throw new Error(`[${id}] 未配置 API Key（BAIBAO_OPENAI_API_KEY）`);
      }

      const res = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [{ role: 'user', content: buildBatchPrompt(reqs) }],
        }),
      });
      if (!res.ok) {
        throw new Error(`[${id}] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? '';
      const parts = parseBatchReply(content, reqs.length);

      // 拆不出来的条目回退为原文，**绝不丢条目**（由质量层再判）
      return reqs.map((r, i) => ({
        id: r.id,
        translated: parts[i] || r.source,
        provider: id,
      }));
    },
  };
}
