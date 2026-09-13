/**
 * 日志总线。
 *
 * 之前所有诊断信息都只能看终端 stdout（`console.log`）。
 * 但**打包后的应用没有终端** —— 用户遇到问题时没有任何线索可看。
 * 这个模块在**主进程内存里**留一个环形缓冲，界面直接读它。
 *
 * ── 三个设计决定 ──
 *
 * ① **内存环形缓冲，不落盘**。
 *    理由：这是"给用户看最近发生了什么"的，不是审计日志。落盘会带来
 *    体积增长、轮转策略、隐私（游戏路径、可能的密钥片段）等一堆问题。
 *    上限固定（`MAX` 条），最老的被挤掉 —— 行为可预期，不会把磁盘写满。
 *
 * ② **同步写入、无异步**。
 *    日志是给排查用的，不能因为"写日志"本身失败而影响主流程。
 *    所以这里只做数组 push（O(1)），不做任何 IO。
 *
 * ③ **只记事实，不记密钥**。
 *    `redact()` 会把看起来像密钥的片段打码。调用方不该传密钥，
 *    但"不该"不等于"不会" —— 所以在唯一的入口兜一层。
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogRecord {
  seq: number;
  time: number;
  level: LogLevel;
  /** 事件类别，便于界面分组/筛选，如 'detect' / 'pipeline' / 'repack' / 'config' */
  scope: string;
  message: string;
}

const MAX = 500;

let seq = 0;
const buf: LogRecord[] = [];

/** 把像密钥的东西打码。宽松匹配：sk- 开头的长串、以及长得像 token 的长串。 */
function redact(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-***')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '***');
}

export function log(level: LogLevel, scope: string, message: string): void {
  const rec: LogRecord = {
    seq: ++seq,
    time: Date.now(),
    level,
    scope,
    message: redact(message),
  };
  buf.push(rec);
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  // 同时打到 stdout：开发期看终端更顺；打包后这行会进 Electron 的日志
  const line = `[bb][${level}][${scope}] ${rec.message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logInfo = (scope: string, m: string): void => log('info', scope, m);
export const logWarn = (scope: string, m: string): void => log('warn', scope, m);
export const logError = (scope: string, m: string): void => log('error', scope, m);

/**
 * 读日志。
 *
 * @param opts.limit 最多返回多少条（**默认返回最近的**，因为排查时关心的是最新）
 * @param opts.level 只看某个级别及以上
 * @param opts.scope 只看某个类别
 * @param opts.sinceSeq 只取这个序号之后的（界面轮询增量时用，避免重复渲染全量）
 */
export function listLogs(opts: {
  limit?: number;
  level?: LogLevel;
  scope?: string;
  sinceSeq?: number;
} = {}): LogRecord[] {
  let out = buf;
  if (opts.sinceSeq !== undefined) out = out.filter((r) => r.seq > opts.sinceSeq!);
  if (opts.scope) out = out.filter((r) => r.scope === opts.scope);
  if (opts.level) {
    const rank: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
    const min = rank[opts.level];
    out = out.filter((r) => rank[r.level] >= min);
  }
  const limit = opts.limit ?? 200;
  // 取最近的 limit 条（而不是最老的）：排查问题时最新的事件最重要
  return out.slice(Math.max(0, out.length - limit));
}

/** 已有的类别（界面做筛选下拉时用） */
export function logScopes(): string[] {
  return [...new Set(buf.map((r) => r.scope))].sort();
}

export function clearLogs(): void {
  buf.length = 0;
}
