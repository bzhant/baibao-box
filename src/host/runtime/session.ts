import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logInfo, logWarn } from '@platform/logbus';
import { BusServer } from '../bus/bus';
import type { ClientIdentity } from '../bus/protocol';

/**
 * 运行时会话：宿主这一侧的"接线板"。
 *
 * 它把三件事接起来：
 *   ① 起总线（原生 hook 连上来握手）；
 *   ② 处理原生侧的取词请求 —— 交给调用方注入的翻译能力；
 *   ③ 反向查询原生侧的运行时统计（宿主 → 原生的 RPC）。
 *
 * **不认识任何引擎**：谁连上来、请求什么原文、怎么翻，全由注入进来的
 * `translator` 决定。这样引擎适配器只要提供"翻译能力"，
 * 运行时这条线就能为任何引擎复用。
 */

/** 一条待译文本。 */
export interface RuntimeTextItem {
  src: string;
}

/** 一条译文。`dst` 为空串 = 宿主确实没有译文 —— 原生侧据此做负缓存，不再重复问。 */
export interface RuntimeTranslation {
  src: string;
  dst: string;
}

/** 宿主提供的翻译能力（由调用方注入，便于测试用确定性实现）。 */
export type RuntimeTranslator = (
  items: RuntimeTextItem[],
  ctx: { from: string; to: string },
) => Promise<RuntimeTranslation[]>;

export interface RuntimeSessionOptions {
  /**
   * 状态文件目录（写 `serverURI` / `listenPort`）。
   *
   * ★ 约定放在 **hook DLL 所在目录** —— 原生侧就是去自己所在目录读 `listenPort`。
   *   注入工具与宿主用一个双方都能算出来的目录当接头地点，不需要额外传参。
   */
  stateDir: string;
  translator: RuntimeTranslator;
  /** 监听端口（默认走总线的 17872，被占用才 +1 探测） */
  port?: number;
}

export interface RuntimeStats {
  /** 引擎侧发起了几次取词请求 */
  batches: number;
  /** 一共要了多少条 */
  requested: number;
  /** 其中有译文的条数 */
  translated: number;
}

interface TranslateArgs {
  from?: string;
  to?: string;
  items?: Array<{ src?: string }>;
}

export class RuntimeSession {
  private readonly bus: BusServer;
  private connected: { no: number; identity: ClientIdentity } | null = null;
  private readonly counters = { batches: 0, requested: 0, translated: 0 };

  constructor(private readonly opts: RuntimeSessionOptions) {
    this.bus = new BusServer({ port: opts.port, stateDir: opts.stateDir });
  }

  /** 起总线并注册命令处理器。原生侧连上来后会自己发起 whoareyou 握手。 */
  async listen(): Promise<{ port: number; uri: string }> {
    // 原生侧上报的"离线词表"（toymap.json 那种）——先记一笔，供工作台显示
    this.bus.handle('reportPairs', (args) => {
      const n = Array.isArray(args) ? args.length : 0;
      logInfo('runtime', `原生侧上报了 ${n} 条离线词表词条`);
      return { ok: true, received: n };
    });

    // ★ 核心：原生侧在热路径上遇到"本地词表没有"的原文，就来这里要译文
    this.bus.handle('translate', async (args) => {
      const a = (args ?? {}) as TranslateArgs;
      const items: RuntimeTextItem[] = (a.items ?? [])
        .map((x) => ({ src: typeof x?.src === 'string' ? x.src : '' }))
        .filter((x) => x.src.length > 0);

      this.counters.batches += 1;
      this.counters.requested += items.length;
      if (items.length === 0) return { items: [] };

      logInfo('runtime', `取词请求：${items.length} 条（如「${items[0].src.slice(0, 30)}」）`);
      const from = a.from ?? 'ja';
      const to = a.to ?? 'zh';
      const got = await this.opts.translator(items, { from, to });

      // 按 src 回填；**请求过的每条都要回**（没译文就回空串），
      // 否则原生侧会以为"还在路上"，每帧重复问同一句。
      const bySrc = new Map(got.map((g) => [g.src, g.dst]));
      const out = items.map((it) => ({ src: it.src, dst: bySrc.get(it.src) ?? '' }));
      const hit = out.filter((o) => o.dst.length > 0).length;
      this.counters.translated += hit;
      logInfo('runtime', `取词应答：${hit}/${items.length} 条有译文`);
      return { items: out };
    });

    const info = await this.bus.listen();
    logInfo('runtime', `总线已监听 ${info.uri}（状态文件写到 ${this.opts.stateDir}）`);
    return info;
  }

  /** 等原生侧连上并完成握手（它会自己应答 whoareyou）。 */
  async waitForClient(timeoutMs = 15_000): Promise<{ no: number; identity: ClientIdentity }> {
    this.connected = await this.bus.waitForClient(timeoutMs);
    const id = this.connected.identity;
    logInfo(
      'runtime',
      `原生侧已接入：client#${this.connected.no} pid=${id.pid ?? '?'} 模块=${id.module ?? '?'} 引擎=${id.engine ?? '?'}`,
    );
    return this.connected;
  }

  /** 宿主 → 原生 的反向 RPC：要对方的运行时统计。 */
  async nativeStats(): Promise<Record<string, number> | null> {
    if (!this.connected) return null;
    try {
      const ret = await this.bus.callClient(this.connected.no, 'runtimeStat');
      return (ret ?? null) as Record<string, number> | null;
    } catch (e) {
      logWarn('runtime', `查询原生侧统计失败：${(e as Error).message}`);
      return null;
    }
  }

  get clientNo(): number {
    return this.connected?.no ?? 0;
  }

  /**
   * 宿主侧账本（只读本地计数，**不触碰对端**，随时可查）。
   *
   * 引擎侧的统计要靠 `nativeStats()` 反向 RPC 去问 —— 那要求它还在线，
   * 所以两件事分开：这里永远是"我这边记的账"，不会因为对端退出而失败。
   */
  stats(): RuntimeStats {
    return { ...this.counters };
  }

  async close(): Promise<void> {
    this.connected = null;
    await this.bus.close();
    // 清掉接头文件。留着的话，下次单独跑 hook（没有宿主）会读到一个**已经没人监听**
    // 的端口；更糟的情况是那个端口后来被别的程序占用，hook 就会把报文发错地方。
    for (const name of ['listenPort', 'serverURI']) {
      await rm(join(this.opts.stateDir, name), { force: true }).catch(() => undefined);
    }
  }
}
