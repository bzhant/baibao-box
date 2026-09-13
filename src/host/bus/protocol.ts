/**
 * 原生侧 ↔ 宿主侧 的通信协议（固定规格，不自行设计）。
 *
 * 传输：WebSocket over 127.0.0.1:17872（被占用则端口 +1 探测，
 *       结果写进 `serverURI` / `listenPort` 两个状态文件供原生侧读取）
 *
 * 请求信封：{"id":int,"type":int,"target":int,"cmd":"<name>","args":any}
 * 应答信封：{"id":int,"ret":any,"error":bool,"type":int}
 *
 * 握手（这个"舞步"是固定语义，按规格实现）：
 *   Server → Client : {"id":3,"type":0,"target":0,"cmd":"whoareyou","args":null}
 *   Client → Server : {"id":3,"type":0,"target":0,"cmd":"whoareyou","args":{<身份>}}
 *   Server → Client : {"id":3,"ret":"server","error":false,"type":1}
 *
 * 约束：
 *   - 每个 cmd 必须在接收侧注册 handler（内部叫 taskHandle）；
 *     未注册必须返回 Error("(Client <n>)Missing taskHandle: <cmd>") 并**附带完整 stack**。
 *   - 必须支持双向 RPC（宿主可调原生，原生也可调宿主）。
 *   - `args` / `ret` 走对象图序列化（见 graph.ts），不是裸 JSON。
 */

/** 请求信封 */
export interface Envelope {
  id: number;
  type: number;
  target: number;
  cmd: string;
  args?: unknown;
}

/** 应答信封 */
export interface ReplyEnvelope {
  id: number;
  ret?: unknown;
  error: boolean;
  type: number;
}

export function isRequest(m: unknown): m is Envelope {
  return (
    typeof m === 'object' && m !== null && typeof (m as Envelope).cmd === 'string' && 'id' in (m as object)
  );
}

export function isReply(m: unknown): m is ReplyEnvelope {
  return (
    typeof m === 'object' && m !== null && !('cmd' in (m as object)) && 'error' in (m as object)
  );
}

/** 握手用的固定 id / 类型 */
export const HANDSHAKE_ID = 3;
export const DEFAULT_PORT = 17872;
export const PORT_PROBE_RANGE = 20;

/** 客户端身份（原生侧上报） */
export interface ClientIdentity {
  /** 目标进程 exe 完整路径 */
  exePath?: string;
  /** 进程号 */
  pid?: number;
  /** 注入的 hook 模块名 */
  module?: string;
  /** 引擎标识，如 'mvmz' | 'krkr' | 'unity' */
  engine?: string;
  /** 位数：32 / 64 */
  arch?: 32 | 64;
  /** 任意附加信息 */
  [key: string]: unknown;
}

/** 未注册 handler 的标准错误信息（原生侧照抄同一格式，便于对照排障） */
export function missingTaskHandleMessage(clientNo: number | string, cmd: string): string {
  return `(Client ${clientNo})Missing taskHandle: ${cmd}`;
}
