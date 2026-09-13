import { createOpenAICompatibleProvider } from './openai-compatible';

/**
 * 翻译 Provider：本地模型（OpenAI 兼容端点，离线）。
 *
 * 用于本地部署的大模型做机翻（**离线、零成本、不上传**），例如：
 *   LM Studio       http://127.0.0.1:1234/v1
 *   Ollama          http://127.0.0.1:11434/v1
 *   llama.cpp server / text-generation-webui 等任何 OpenAI 兼容端点
 *
 * 环境变量可覆盖：
 *   BAIBAO_LOCAL_LLM_BASE_URL  默认 http://127.0.0.1:1234/v1
 *   BAIBAO_LOCAL_LLM_MODEL     默认 local-model
 */
export const localLLMProvider = createOpenAICompatibleProvider({
  id: 'local-llm',
  displayName: '本地模型（离线）',
  baseUrl: process.env.BAIBAO_LOCAL_LLM_BASE_URL ?? 'http://127.0.0.1:1234/v1',
  model: process.env.BAIBAO_LOCAL_LLM_MODEL ?? 'local-model',
  offline: true,
});
