import type { DetectResult, EngineAdapter, EngineCaps, TranslationProvider } from '@shared/contracts';

/**
 * 插件注册表：引擎适配器 × 翻译 Provider 的统一注册/发现。
 * platform 层（基础设施），只允许被上层调用，不反向依赖上层。
 */
class PluginRegistry {
  private engines = new Map<string, EngineAdapter>();
  private providers = new Map<string, TranslationProvider>();

  // ── 引擎适配器 ─────────────────────────────────────────────
  registerEngine(adapter: EngineAdapter): void {
    if (this.engines.has(adapter.id)) {
      throw new Error(`[registry] 引擎适配器重复注册: ${adapter.id}`);
    }
    this.engines.set(adapter.id, adapter);
  }

  getEngine(id: string): EngineAdapter | undefined {
    return this.engines.get(id);
  }

  /**
   * 给界面用的引擎清单（**可序列化**）。
   *
   * ⚠️ 只返回纯数据：适配器对象上挂着函数（detect/extract/repack），
   *    直接发到渲染层会被结构化克隆拒绝（或悄悄丢字段）。
   *    所以这里显式挑出"界面需要的那几项"，而不是把整个 adapter 递出去。
   */
  listManifests(): Array<{
    id: string;
    displayName: string;
    rootHint: string;
    sourceLanguages: Array<{ id: string; label: string }>;
    fontOptionNote?: string;
    caveats: string[];
    capabilities: EngineCaps;
  }> {
    return this.listEngines().map((a) => ({
      id: a.id,
      displayName: a.displayName,
      rootHint: a.manifest?.rootHint ?? '',
      sourceLanguages: a.manifest?.sourceLanguages ?? [],
      fontOptionNote: a.manifest?.fontOptionNote,
      caveats: a.manifest?.caveats ?? [],
      capabilities: a.capabilities,
    }));
  }

  listEngines(): EngineAdapter[] {
    return [...this.engines.values()];
  }

  /**
   * 对游戏目录跑所有已注册适配器的探测，按置信度降序返回命中的结果。
   * 宽容模式：即使没有任何适配器 matched，也返回 confidence 最高的候选供人工确认。
   */
  async detectAll(gameDir: string): Promise<DetectResult[]> {
    const results = await Promise.all(
      this.listEngines().map(async (e) => {
        try {
          return await e.detect(gameDir);
        } catch (err) {
          return {
            matched: false,
            engineId: e.id,
            confidence: 0,
            notes: [`detect 抛错: ${(err as Error).message}`],
          } as DetectResult;
        }
      }),
    );
    return results
      .filter((r) => r.matched || r.confidence > 0.3)
      .sort((a, b) => b.confidence - a.confidence);
  }

  // ── 翻译 Provider ──────────────────────────────────────────
  registerProvider(provider: TranslationProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`[registry] 翻译 Provider 重复注册: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  getProvider(id: string): TranslationProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): TranslationProvider[] {
    return [...this.providers.values()];
  }

  listOfflineProviders(): TranslationProvider[] {
    return this.listProviders().filter((p) => p.offline);
  }
}

/** 全局单例 */
export const registry = new PluginRegistry();
