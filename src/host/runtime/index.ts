import { dirname } from 'node:path';
import { logInfo } from '@platform/logbus';
import { detectPeArch, launchInjected, resolveNativeDir, type PeArch } from './launcher';
import { RuntimeSession, type RuntimeTranslator } from './session';

export * from './launcher';
export * from './session';

/**
 * 运行时注入这条线的总入口。
 *
 * 一次调用把整条链路接起来：
 *   起总线（原生侧要连的接头地点）→ 用原生注入器把 hook 带进游戏 →
 *   等原生侧握手 → 返回一个正在工作的会话，此后宿主只要应答取词请求即可。
 *
 * ★ 这里**不碰任何引擎细节**：目标 exe、hook DLL、翻译能力都由调用方给。
 *   引擎适配器要做的只是"提供一份翻译能力 + 一个能用的 hook DLL"。
 */

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

export interface RuntimeHandle {
  session: RuntimeSession;
  /** 目标进程号 */
  pid: number;
  arch: PeArch;
  /** 总线实际监听的端口 */
  port: number;
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

  // 状态文件放在 hook DLL 同目录 —— 原生侧就是去**自己所在目录**读 listenPort，
  // 这样宿主换了端口（17872 被占用）原生侧也能跟上，不用改代码。
  const stateDir = dirname(o.dll);
  const session = new RuntimeSession({ stateDir, translator: o.translator });

  const info = await session.listen();
  const outcome = await launchInjected({ exe: o.exe, dll: o.dll, nativeDir });

  if (!outcome.ok || outcome.pid === null) {
    await session.close();
    const detail = outcome.errors.length > 0 ? `（${outcome.errors.join(' / ')}）` : '';
    throw new Error(`注入启动失败：${outcome.message}${detail}`);
  }

  try {
    await session.waitForClient(o.clientTimeoutMs ?? 20_000);
  } catch (e) {
    await session.close();
    throw new Error(
      `目标进程已启动（pid=${outcome.pid}），但它没有连上总线：${(e as Error).message}` +
        `（可查 hook 日志：${stateDir} 目录下）`,
    );
  }

  logInfo('runtime', `运行时链路已打通：pid=${outcome.pid} 架构=${arch} 总线 ${info.uri}`);
  return { session, pid: outcome.pid, arch, port: info.port };
}
