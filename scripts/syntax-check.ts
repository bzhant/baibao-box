/**
 * 语法/加载自检：确认"只依赖 import type"的模块能被 Node 干净加载（type 被擦除）。
 * mvmz/index.ts 因使用打包器风格的扩展名省略导入，不在此列（由 vitest 集成测试覆盖）。
 * 用法： node --experimental-strip-types scripts/syntax-check.ts
 */
import { registry } from '../src/platform/plugin-registry.ts';
import { openAIProvider } from '../src/translate/providers/openai.ts';
import { extractEventText, isEventFile } from '../src/engines/mvmz/event-text.ts';

let ok = 0;
let bad = 0;
const t = (name: string, cond: boolean) => {
  if (cond) { ok++; console.log(`  ok  ${name}`); }
  else { bad++; console.log(`  FAIL ${name}`); }
};

t('plugin-registry 可加载且为单例', typeof registry.registerEngine === 'function');
t('registry 初始为空', registry.listEngines().length === 0 && registry.listProviders().length === 0);
t('openAIProvider 结构完整', openAIProvider.id === 'openai' && typeof openAIProvider.translate === 'function');
t('event-text 导出可用', typeof extractEventText === 'function' && isEventFile('Map001.json') === true);

// 模拟一次注册往返
registry.registerProvider(openAIProvider);
t('注册 Provider 后可见', registry.listProviders().length === 1);

console.log(`\n结果: ${ok} 通过, ${bad} 失败`);
process.exit(bad === 0 ? 0 : 1);
