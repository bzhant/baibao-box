import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logInfo } from '@platform/logbus';
import { detectPeArch, launchInjected, resolveNativeDir, type PeArch } from './launcher';
import { RuntimeSession, type RuntimeTranslator } from './session';

export * from './launcher';
export * from './session';
export * from './translator';
export * from './translation-store';
export * from './mvmz-activator';
export * from './game-lock';

/**
 * 找 MV/MZ 运行时桥插件。
 *
 * 开发态在仓库里（`tools/mv-runtime/`），打包后随 extraResources 落在
 * `resources/bb-runtime/`。两处都找不到就返回 null，调用方给出可读的报错。
 */
export function resolveBridgePath(explicit?: string): string | null {
  const resources =
    typeof (process as unknown as { resourcesPath?: string }).resourcesPath === 'string'
      ? (process as unknown as { resourcesPath: string }).resourcesPath
      : '';
  const candidates = [
    explicit,
    process.env['BB_BRIDGE_PATH'],
    join(process.cwd(), 'tools', 'mv-runtime', 'BB_RuntimeBridge.js'),
    resources ? join(resources, 'bb-runtime', 'BB_RuntimeBridge.js') : undefined,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * 运行时注入这条线的总入口。
 *
 * 这条线由**两个可替换的半边**拼成：
 *
 *   ① 会话（本文件 + session.ts）—— 起总线、应答取词、反向查统计。**引擎无关**。
 *   ② 激活方式（RuntimeActivator）—— 怎么把"引擎侧的 hook"装进目标、让它跑起来。
 *      引擎不同，装法完全不同：
 *        · 原生引擎（老 galgame）：注入 DLL（native/injector）
 *        · MV / MZ：文本全程在 JS 里，编码层 hook 看不见东西 ——
 *          只能在 JS 层挂真实绘制入口，装法是"可逆地装一个插件"
 *
 * 把这两半边分开，是为了让**同一套会话**同时服务两类引擎 ——
 * 否则每支持一个引擎就要把总线、握手、取词应答再抄一遍。
 */

/** 激活结果：目标跑起来了，附带一点可观测信息。 */
export interface RuntimeActivation {
  /** 目标进程号（注入路线拿得到；JS 插件路线拿不到，可省略） */
  pid?: number;
  arch?: PeArch;
  /** 给人看的说明（写进日志，便于对照） */
  detail?: string;
}

/** 激活时能拿到的上下文（引擎侧要把端口告诉自己的 hook/bridge）。 */
export interface ActivationContext {
  /** 总线端口 */
  port: number;
  /** 总线地址，如 ws://127.0.0.1:17873 */
  uri: string;
}

export interface RuntimeActivator {
  /** 把引擎侧的 hook/bridge 装进目标并让它开始跑。**返回时目标应当在启动中/已运行。** */
  activate(ctx: ActivationContext): Promise<RuntimeActivation>;
  /** 收尾：还原现场（卸载 hook / 恢复被改的游戏文件） */
  deactivate?(): Promise<void>;
}

export interface StartSessionOptions {
  translator: RuntimeTranslator;
  activator: RuntimeActivator;
  /**
   * 接头文件目录（写 `listenPort` / `serverURI`）。
   * 原生路线约定放 **hook DLL 同目录** —— 原生侧就是去自己所在目录读端口。
   */
  stateDir: string;
  /** 等引擎侧握手的时间 */
  clientTimeoutMs?: number;
}

export interface RuntimeHandle {
  session: RuntimeSession;
  /** 目标进程号（JS 插件路线为 null） */
  pid: number | null;
  arch?: PeArch;
  /** 总线实际监听的端口 */
  port: number;
  activation: RuntimeActivation;
}

/**
 * 起会话 → 激活引擎侧 → 等它握手。三步都成了才算"这条线通了"。
 *
 * ★ 顺序不能反：**必须先起总线再激活目标**。反过来的话，目标启动时找不到接头地点
 *   （原生侧读不到 `listenPort` 就干脆不连），表现成"注入了却永远连不上"。
 */
export async function startRuntimeSessionWith(o: StartSessionOptions): Promise<RuntimeHandle> {
  const session = new RuntimeSession({ stateDir: o.stateDir, translator: o.translator });
  const info = await session.listen();

  let activation: RuntimeActivation;
  try {
    activation = await o.activator.activate({ port: info.port, uri: info.uri });
  } catch (e) {
    await session.close();
    throw e;
  }

  try {
    await session.waitForClient(o.clientTimeoutMs ?? 20_000);
  } catch (e) {
    await session.close();
    throw new Error(
      `目标已启动，但它没有连上总线：${(e as Error).message}` +
        `（可查引擎侧日志 / hook 日志：${o.stateDir} 目录下）`,
    );
  }

  logInfo('runtime', `运行时链路已打通：${activation.detail ?? ''} 总线 ${info.uri}`);
  return { session, pid: activation.pid ?? null, arch: activation.arch, port: info.port, activation };
}

// ── 激活方式之一：原生注入（自带 hook DLL 的引擎）────────────────────

export interface StartRuntimeSessionOptions {
  /** 目标游戏 exe（绝对路径） */
  exe: string;
  /** 要注入的 hook DLL（绝对路径） */
  dll: string;
  /** native/ 目录（不给就自动找） */
  nativeDir?: string;
  /** 翻译能力 */
  translator: RuntimeTranslator;
  /** 等原生侧握手的时间 */
  clientTimeoutMs?: number;
}

export async function startRuntimeSession(o: StartRuntimeSessionOptions): Promise<RuntimeHandle> {
  const nativeDir = resolveNativeDir(o.nativeDir);
  if (!nativeDir) {
    throw new Error('找不到 native/ 构建产物目录（先在 native/ 里跑一次 node build.mjs）');
  }
  const arch = detectPeArch(o.exe);
  if (arch === null) {
    throw new Error(`读不出目标位数：${o.exe}（不是合法 PE，或架构不受支持）`);
  }

  return startRuntimeSessionWith({
    translator: o.translator,
    // 接头文件放 hook DLL 同目录 —— 原生侧去自己所在目录读 listenPort，
    // 这样宿主换了端口原生侧也能跟上，不用改代码。
    stateDir: dirname(o.dll),
    clientTimeoutMs: o.clientTimeoutMs,
    activator: {
      async activate() {
        const outcome = await launchInjected({ exe: o.exe, dll: o.dll, nativeDir });
        if (!outcome.ok || outcome.pid === null) {
          const detail = outcome.errors.length > 0 ? `（${outcome.errors.join(' / ')}）` : '';
          throw new Error(`注入启动失败：${outcome.message}${detail}`);
        }
        return { pid: outcome.pid, arch, detail: `原生注入 pid=${outcome.pid}` };
      },
    },
  });
}
