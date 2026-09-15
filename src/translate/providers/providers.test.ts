import { describe, it, expect } from 'vitest';
import { createOpenAICompatibleProvider, buildBatchPrompt, parseBatchReply } from './openai-compatible';
import { createDeepLProvider } from './deepl';
import { createGoogleProvider, parseGoogleResponse } from './google';
import { createYoudaoProvider, youdaoSign } from './youdao';
import type { TranslateRequest } from '@shared/contracts';

/** 造一个假 fetch，记录每次请求，返回预设响应 */
function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body ?? {},
      text: async () => r.text ?? JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const reqs = (...sources: string[]): TranslateRequest[] =>
  sources.map((s, i) => ({ id: String(i), source: s, from: 'ja', to: 'zh-CN' }));

// ── OpenAI 兼容 ────────────────────────────────────────────────
describe('OpenAI 兼容 Provider', () => {
  it('提示词要求保留占位符、按序号返回', () => {
    const p = buildBatchPrompt(reqs('こんにちは、__BB0__！'));
    expect(p).toContain('__BB0__');
    expect(p).toContain('原样保留');
    expect(p).toContain('[0] こんにちは、__BB0__！');
    expect(p).toContain('zh-CN');
  });

  it('按 [序号] 拆回译文（含多行）', () => {
    const parts = parseBatchReply('[0] 你好\n[1] 世界\n\n[2] 第三行', 3);
    expect(parts).toEqual(['你好', '世界', '第三行']);
  });

  it('请求构造正确（Bearer 鉴权 + model），响应按序映射', async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: { choices: [{ message: { content: '[0] 你好\n[1] 再见' } }] },
    }));
    const p = createOpenAICompatibleProvider({ apiKey: 'sk-test', baseUrl: 'https://x.test/v1', model: 'm', fetchFn: fn });
    const out = await p.translate(reqs('こんにちは', 'さようなら'));
    expect(out.map((r) => r.translated)).toEqual(['你好', '再见']);

    expect(calls[0].url).toBe('https://x.test/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe('m');
    expect(body.messages[0].content).toContain('こんにちは');
  });

  it('拆不出时返回空译文，让流水线保留待译状态', async () => {
    const { fn } = fakeFetch(() => ({ body: { choices: [{ message: { content: '模型胡说八道' } }] } }));
    const p = createOpenAICompatibleProvider({ apiKey: 'k', fetchFn: fn });
    const out = await p.translate(reqs('あ', 'い'));
    expect(out.map((r) => r.translated)).toEqual(['', '']);
  });

  it('支持 SSE 流式响应并拼接增量内容', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"[0] 你"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchFn = (async () => new Response(stream, {
      headers: { 'content-type': 'text/event-stream' },
    })) as typeof fetch;
    const p = createOpenAICompatibleProvider({ apiKey: 'k', fetchFn });
    const out = await p.translate(reqs('こんにちは'));
    expect(out[0].translated).toBe('你好');
  });

  it('云端缺密钥报错；本地（offline）免密钥', async () => {
    const { fn } = fakeFetch(() => ({ body: { choices: [{ message: { content: '[0] x' } }] } }));
    const cloud = createOpenAICompatibleProvider({ fetchFn: fn, apiKey: undefined as unknown as string });
    // 明确清掉环境变量影响
    const saved = process.env.BAIBAO_OPENAI_API_KEY;
    delete process.env.BAIBAO_OPENAI_API_KEY;
    await expect(cloud.translate(reqs('a'))).rejects.toThrow(/API Key/);
    const local = createOpenAICompatibleProvider({ offline: true, fetchFn: fn });
    await expect(local.translate(reqs('a'))).resolves.toHaveLength(1);
    if (saved !== undefined) process.env.BAIBAO_OPENAI_API_KEY = saved;
  });

  it('HTTP 非 2xx 抛错', async () => {
    const { fn } = fakeFetch(() => ({ status: 429, text: 'rate limited' }));
    const p = createOpenAICompatibleProvider({ apiKey: 'k', fetchFn: fn });
    await expect(p.translate(reqs('a'))).rejects.toThrow(/429/);
  });

  it('超时会中止请求，不会无限等待', async () => {
    const fetchFn = ((_input: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    })) as typeof fetch;
    const p = createOpenAICompatibleProvider({ apiKey: 'k', fetchFn, timeoutMs: 5 });
    await expect(p.translate(reqs('a'))).rejects.toThrow(/超时/);
  });
});

// ── DeepL ─────────────────────────────────────────────────────
describe('DeepL Provider', () => {
  it('批量请求：text 数组 + 语言码转换 + DeepL-Auth-Key', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { translations: [{ text: '你好' }, { text: '再见' }] } }));
    const p = createDeepLProvider({ apiKey: 'dk', baseUrl: 'https://api-free.deepl.com', fetchFn: fn });
    const out = await p.translate(reqs('こんにちは', 'さようなら'));
    expect(out.map((r) => r.translated)).toEqual(['你好', '再见']);

    expect(calls[0].url).toBe('https://api-free.deepl.com/v2/translate');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('DeepL-Auth-Key dk');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.text).toEqual(['こんにちは', 'さようなら']);
    expect(body.source_lang).toBe('JA');
    expect(body.target_lang).toBe('ZH');
  });

  it('缺密钥报错', async () => {
    const saved = process.env.DEEPL_API_KEY;
    delete process.env.DEEPL_API_KEY;
    const p = createDeepLProvider({ fetchFn: fakeFetch(() => ({})).fn });
    await expect(p.translate(reqs('a'))).rejects.toThrow(/DEEPL_API_KEY/);
    if (saved !== undefined) process.env.DEEPL_API_KEY = saved;
  });
});

// ── Google ────────────────────────────────────────────────────
describe('Google 翻译 Provider', () => {
  it('URL 构造：client=gtx + sl/tl + 多个 q', async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: [[[['你好', 'こんにちは']], [['再见', 'さようなら']]]],
    }));
    const p = createGoogleProvider({ fetchFn: fn });
    const out = await p.translate(reqs('こんにちは', 'さようなら'));
    expect(out.map((r) => r.translated)).toEqual(['你好', '再见']);

    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://translate.googleapis.com/translate_a/single');
    expect(u.searchParams.get('client')).toBe('gtx');
    expect(u.searchParams.get('sl')).toBe('ja');
    expect(u.searchParams.get('tl')).toBe('zh-CN');
    expect(u.searchParams.getAll('q')).toEqual(['こんにちは', 'さようなら']);
  });

  it('解析单 q 的多段落（拼接）', () => {
    const raw = [[['第一段', 'a'], ['第二段', 'b']]];
    expect(parseGoogleResponse(raw, 1)).toEqual(['第一段第二段']);
  });

  it('解析多 q 分组', () => {
    const raw = [[[['A1', 'src']], [['B1', 'src'], ['B2', 'src']]]];
    expect(parseGoogleResponse(raw, 2)).toEqual(['A1', 'B1B2']);
  });

  it('结构异常时返回空（由上层回退原文）', () => {
    expect(parseGoogleResponse({ unexpected: true }, 2)).toEqual(['', '']);
  });
});

// ── 有道 ──────────────────────────────────────────────────────
describe('有道 Provider', () => {
  it('v3 签名计算正确且请求体包含全部字段', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { errorCode: '0', translation: ['你好'] } }));
    const p = createYoudaoProvider({
      appKey: 'AK',
      appSecret: 'AS',
      fetchFn: fn,
      now: () => 1700000000000,
      saltFn: () => 'SALT',
    });
    const out = await p.translate(reqs('こんにちは'));
    expect(out[0].translated).toBe('你好');

    const body = new URLSearchParams(String(calls[0].init.body));
    expect(body.get('q')).toBe('こんにちは');
    expect(body.get('from')).toBe('ja');
    expect(body.get('to')).toBe('zh-CHS');
    expect(body.get('appKey')).toBe('AK');
    expect(body.get('salt')).toBe('SALT');
    expect(body.get('curtime')).toBe('1700000000');
    expect(body.get('signType')).toBe('v3');
    expect(body.get('sign')).toBe(youdaoSign('AK', 'こんにちは', 'SALT', '1700000000', 'AS'));
  });

  it('多段译文用换行拼接', async () => {
    const { fn } = fakeFetch(() => ({ body: { errorCode: '0', translation: ['第一行', '第二行'] } }));
    const p = createYoudaoProvider({ appKey: 'a', appSecret: 'b', fetchFn: fn });
    const out = await p.translate(reqs('x'));
    expect(out[0].translated).toBe('第一行\n第二行');
  });

  it('errorCode 非 0 抛错', async () => {
    const { fn } = fakeFetch(() => ({ body: { errorCode: '401', translation: [] } }));
    const p = createYoudaoProvider({ appKey: 'a', appSecret: 'b', fetchFn: fn });
    await expect(p.translate(reqs('x'))).rejects.toThrow(/401/);
  });

  it('缺密钥报错', async () => {
    const savedK = process.env.YOUDAO_APP_KEY;
    const savedS = process.env.YOUDAO_APP_SECRET;
    delete process.env.YOUDAO_APP_KEY;
    delete process.env.YOUDAO_APP_SECRET;
    const p = createYoudaoProvider({ fetchFn: fakeFetch(() => ({})).fn });
    await expect(p.translate(reqs('x'))).rejects.toThrow(/YOUDAO_APP_KEY/);
    if (savedK !== undefined) process.env.YOUDAO_APP_KEY = savedK;
    if (savedS !== undefined) process.env.YOUDAO_APP_SECRET = savedS;
  });
});
