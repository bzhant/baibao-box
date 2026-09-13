import { createOpenAICompatibleProvider } from './openai-compatible';

/**
 * 翻译 Provider：OpenAI（云端，OpenAI 兼容端点）。
 *
 * 通过环境变量配置，避免把密钥写进代码：
 *   BAIBAO_OPENAI_BASE_URL  默认 https://api.openai.com/v1
 *   BAIBAO_OPENAI_API_KEY
 *   BAIBAO_OPENAI_MODEL     默认 gpt-4o-mini
 */
export const openAIProvider = createOpenAICompatibleProvider({
  id: 'openai',
  displayName: 'OpenAI',
  baseUrl: process.env.BAIBAO_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
  apiKey: process.env.BAIBAO_OPENAI_API_KEY,
  model: process.env.BAIBAO_OPENAI_MODEL ?? 'gpt-4o-mini',
  offline: false,
});
