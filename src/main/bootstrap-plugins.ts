import { registry } from '@platform/plugin-registry';
import { mvmzAdapter } from '../engines/mvmz';
import { renpyAdapter } from '../engines/renpy';
import { krkrAdapter } from '../engines/krkr';
import { openAIProvider } from '../translate/providers/openai';

/** 幂等：窗口路径与 CLI 路径都会调用它，重复注册会抛错。 */
let registered = false;

/**
 * 内置插件注册。
 * 后续引擎/Provider 增多时，这里只负责"收集并注册"，不掺逻辑。
 */
export function registerBuiltinPlugins(): void {
  if (registered) return;
  registered = true;

  // 引擎适配器
  registry.registerEngine(mvmzAdapter); // P0  RPG Maker MV/MZ
  registry.registerEngine(renpyAdapter); // P1  Ren'Py
  registry.registerEngine(krkrAdapter); // P1  KiriKiri 2 / Z（.ks；.scn/.tjs 待补）
  // TODO: VX/ACE · Tyrano · Wolf · Unity …

  // 翻译 Provider
  registry.registerProvider(openAIProvider);
  // TODO: deepl / google / youdao / local-llm
}
