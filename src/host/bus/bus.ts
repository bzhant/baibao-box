import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { encodeGraph, decodeGraph, encodePlain, isGraphWire, type Graph, type WireFormat } from './graph';
import { logInfo } from '@platform/logbus';
import {
  DEFAULT_PORT,
  HANDSHAKE_ID,
  PORT_PROBE_RANGE,
  isRequest,
  isReply,
  missingTaskHandleMessage,
  type ClientIdentity,
  type Envelope,
  type ReplyEnvelope,
} from './protocol';

/**
 * 本地 RPC 总线（隧道：WebSocket over 127.0.0.1）。
 *
 * 这一层是**注入架构的地基**：hook DLL 注入进游戏后，就是靠它
 * ① 上报身份、② 把抓到的 <原文> 发给宿主、③ 拿回 <译文> 回填。
 *
 * 设计要点（都是踩过的坑）：
 *  - **端口探测**：17872 被占用就 +1 试，并把最终端口写进 `serverURI` / `listenPort`
 *    状态文件 —— 原生侧启动时读这两个文件，而不是写死端口。
 *  - **taskHandle 必须注册**：调用未注册的命令要返回**明确的**错误（含完整 stack），
 *    否则原生侧只能看到"没反应"，排障会瞎。
 *  - **args/ret 走对象图**：Error 的 stack、Map、循环引用都要能过网线。
 */

type Handler = (args: unknown, ctx: RpcContext) => unknown | Promise<unknown>;

export interface RpcContext {
  /** 该连接在服务端的编号（1 基），用于错误信息里的 "Client N" */
  clientNo: number;
  identity: ClientIdentity;
  /** 反向调用：宿主 → 原生 */
  call: (cmd: string, args?: unknown) => Promise<unknown>;
  /** 谁在问（供 handler 判断） */
  send: (data: unknown) => void;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Conn {
  no: number;
  ws: WebSocket;
  identity: ClientIdentity;
  nextId: number;
  pending: Map<number, Pending>;
  /** 该连接用哪种线格式（握手时由对端声明，见 graph.ts 的 WireFormat） */
  wire: WireFormat;
}

export interface BusServerOptions {
  /** 起始端口，默认 17872 */
  port?: number;
  /** 状态文件目录（写 serverURI / listenPort）；不传则不写 */
  stateDir?: string;
  /** 单次调用超时（毫秒），默认 15s */
  callTimeoutMs?: number;
}

export class BusServer {
  private wss: WebSocketServer | null = null;
  private readonly handlers = new Map<string, Handler>();
  private readonly conns = new Map<WebSocket, Conn>();
  private nextClientNo = 1;
  private serverUri = '';

  constructor(private readonly opts: BusServerOptions = {}) {}

  /** 注册一个命令处理器（内部称 taskHandle） */
  handle(cmd: string, fn: Handler): this {
    this.handlers.set(cmd, fn);
    return this;
  }

  get port(): number {
    return this.wss ? (this.wss.address() as { port: number }).port : 0;
  }

  get uri(): string {
    return this.serverUri;
  }

  /** 已连接的客户端快照 */
  clients(): Array<{ no: number; identity: ClientIdentity }> {
    return [...this.conns.values()].map((c) => ({ no: c.no, identity: c.identity }));
  }

  /** 起服务：端口探测 + 写状态文件 + 握手 */
  async listen(): Promise<{ port: number; uri: string }> {
    const start = this.opts.port ?? DEFAULT_PORT;
    let lastErr: Error | null = null;

    for (let p = start; p < start + PORT_PROBE_RANGE; p++) {
      try {
        const wss = await this.tryListen(p);
        this.wss = wss;
        this.serverUri = `ws://127.0.0.1:${p}`;
        wss.on('connection', (ws, req) => this.onConnection(ws, req.url ?? '/'));
        await this.writeStateFiles(p);
        return { port: p, uri: this.serverUri };
      } catch (err) {
        lastErr = err as Error;
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EADDRINUSE') throw err; // 其它错误（如权限）直接抛
      }
    }
    throw new Error(
      `端口 ${start}~${start + PORT_PROBE_RANGE - 1} 全被占用，起不来总线：${lastErr?.message ?? ''}`,
    );
  }

  private tryListen(port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: '127.0.0.1', port });
      const onError = (err: Error) => {
        wss.removeListener('listening', onListening);
        wss.close();
        reject(err);
      };
      const onListening = () => {
        wss.removeListener('error', onError);
        resolve(wss);
      };
      wss.once('error', onError);
      wss.once('listening', onListening);
    });
  }

  /** 写 serverURI / listenPort 状态文件（原生侧靠它找到端口） */
  private async writeStateFiles(port: number): Promise<void> {
    if (!this.opts.stateDir) return;
    await fs.mkdir(this.opts.stateDir, { recursive: true });
    await fs.writeFile(join(this.opts.stateDir, 'serverURI'), this.serverUri, 'utf8');
    await fs.writeFile(join(this.opts.stateDir, 'listenPort'), String(port), 'utf8');
  }

  private onConnection(ws: WebSocket, url: string): void {
    // 对端在握手时声明线格式：连 `/plain` = 简易 JSON（C++ 原生侧）。
    // 必须在**发出第一条消息之前**就确定 —— 那条 whoareyou 就得按这个格式发。
    const wire: WireFormat = url.includes('plain') ? 'plain' : 'graph';
    const conn: Conn = {
      no: this.nextClientNo++,
      ws,
      identity: {},
      nextId: 1,
      pending: new Map(),
      wire,
    };
    this.conns.set(ws, conn);
    // 线格式不一致是这套架构里最难查的一类故障（表现为"发出去没反应"），
    // 所以不静默选择：连上就把用的是哪种写进日志。
    logInfo('bus', `client#${conn.no} 接入，线格式=${wire}`);

    ws.on('message', (data) => void this.onMessage(conn, data.toString()));
    ws.on('close', () => {
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`连接已断开（Client ${conn.no}）`));
      }
      conn.pending.clear();
      this.conns.delete(ws);
    });
    ws.on('error', () => ws.close());

    // 握手第一步：问它是谁
    this.send(conn, {
      id: HANDSHAKE_ID,
      type: 0,
      target: 0,
      cmd: 'whoareyou',
      args: null,
    } satisfies Envelope);
  }

  private send(conn: Conn, msg: unknown): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    const payload =
      conn.wire === 'plain' ? JSON.stringify(encodePlain(msg)) : JSON.stringify(encodeGraph(msg));
    conn.ws.send(payload);
  }

  private async onMessage(conn: Conn, text: string): Promise<void> {
    let msg: unknown;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isGraphWire(parsed)) {
        msg = decodeGraph(parsed as Graph);
      } else if (conn.wire === 'plain') {
        // 简易格式：本来就是裸 JSON，直接用
        msg = parsed;
      } else {
        // 声明用对象图、却发来裸 JSON —— 这是**协议违约**。
        // 明确报错比"猜着解"要好：猜错的话错误会出现在很远的地方，极难定位。
        throw new Error('本连接声明使用对象图格式，但收到的是裸 JSON');
      }
    } catch (err) {
      conn.ws.close(1002, `报文无法解析: ${(err as Error).message}`);
      return;
    }

    if (isRequest(msg)) {
      await this.onRequest(conn, msg);
      return;
    }
    if (isReply(msg)) {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.ret instanceof Error ? msg.ret : new Error(String(msg.ret));
        p.reject(e);
      } else {
        p.resolve(msg.ret);
      }
    }
  }

  private async onRequest(conn: Conn, req: Envelope): Promise<void> {
    const reply = (ret: unknown, error = false): void =>
      this.send(conn, { id: req.id, ret, error, type: 1 } satisfies ReplyEnvelope);

    // 协议级命令：whoareyou（不占 handler 名额）
    if (req.cmd === 'whoareyou') {
      conn.identity = (req.args ?? {}) as ClientIdentity;
      reply('server');
      return;
    }

    const fn = this.handlers.get(req.cmd);
    if (!fn) {
      // 未注册必须明确报错，并把 stack 一并送回去 —— 否则原生侧只能看到"没反应"
      const err = new Error(missingTaskHandleMessage(conn.no, req.cmd));
      err.name = 'MissingTaskHandleError';
      reply(err, true);
      return;
    }

    const ctx: RpcContext = {
      clientNo: conn.no,
      identity: conn.identity,
      call: (cmd, args) => this.call(conn, cmd, args),
      send: (data) => this.send(conn, data),
    };

    try {
      reply(await fn(req.args, ctx));
    } catch (err) {
      reply(err instanceof Error ? err : new Error(String(err)), true);
    }
  }

  /** 宿主 → 指定连接 反向调用 */
  private call(conn: Conn, cmd: string, args?: unknown): Promise<unknown> {
    const id = conn.nextId++;
    const timeout = this.opts.callTimeoutMs ?? 15_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`调用 ${cmd} 超时（${timeout}ms）`));
      }, timeout);
      conn.pending.set(id, { resolve, reject, timer });
      this.send(conn, { id, type: 0, target: 0, cmd, args } satisfies Envelope);
    });
  }

  /** 宿主 → 全部已连接客户端 */
  broadcast(cmd: string, args?: unknown): Promise<unknown[]> {
    return Promise.all([...this.conns.values()].map((c) => this.call(c, cmd, args)));
  }

  /** 宿主 → 第 n 号客户端 */
  callClient(no: number, cmd: string, args?: unknown): Promise<unknown> {
    const conn = [...this.conns.values()].find((c) => c.no === no);
    if (!conn) return Promise.reject(new Error(`没有第 ${no} 号客户端`));
    return this.call(conn, cmd, args);
  }

  /**
   * 等某个客户端连上**并完成握手**（身份非空）。
   *
   * 用轮询而不是监听事件：whoareyou 的处理是异步的（`await onRequest`），
   * 事件监听器可能在身份赋值前就触发，导致"连上了但身份还是空"的竞态。
   */
  async waitForClient(
    timeoutMs = 10_000,
    signal?: AbortSignal,
  ): Promise<{ no: number; identity: ClientIdentity }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('等待客户端连接已取消');
      }
      const hit = this.clients().find((c) => Object.keys(c.identity).length > 0);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`等待客户端连接超时（${timeoutMs}ms）`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async close(): Promise<void> {
    for (const c of this.conns.values()) {
      for (const p of c.pending.values()) clearTimeout(p.timer);
      c.ws.close();
    }
    this.conns.clear();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    this.wss = null;
  }
}

/**
 * 总线客户端（原生侧的参考实现 / 测试用的对端）。
 * C++ 侧照这个语义实现即可。
 */
export class BusClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Handler>();
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private myClientNo = 0;

  constructor(
    private readonly identity: ClientIdentity = {},
    private readonly callTimeoutMs = 15_000,
  ) {}

  handle(cmd: string, fn: Handler): this {
    this.handlers.set(cmd, fn);
    return this;
  }

  get clientNo(): number {
    return this.myClientNo;
  }

  connect(uri: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(uri);
      this.ws = ws;
      ws.once('open', () => resolve());
      ws.once('error', (err) => reject(err));
      ws.on('message', (data) => void this.onMessage(data.toString()));
      ws.on('close', () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('连接已关闭'));
        }
        this.pending.clear();
      });
    });
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(encodeGraph(msg)));
  }

  private async onMessage(text: string): Promise<void> {
    let msg: unknown;
    try {
      msg = decodeGraph(JSON.parse(text) as Graph);
    } catch {
      return;
    }

    if (isRequest(msg)) {
      // 握手：服务端问"你是谁"，客户端用**同样的 id** 发一个 whoareyou 请求回去
      if (msg.cmd === 'whoareyou') {
        this.send({
          id: msg.id,
          type: 0,
          target: 0,
          cmd: 'whoareyou',
          args: this.identity,
        } satisfies Envelope);
        return;
      }
      const fn = this.handlers.get(msg.cmd);
      const reply = (ret: unknown, error = false): void =>
        this.send({ id: msg.id, ret, error, type: 1 } satisfies ReplyEnvelope);
      if (!fn) {
        reply(new Error(missingTaskHandleMessage('server', msg.cmd)), true);
        return;
      }
      try {
        reply(
          await fn(msg.args, {
            clientNo: this.myClientNo,
            identity: this.identity,
            call: (cmd, args) => this.call(cmd, args),
            send: (d) => this.send(d),
          }),
        );
      } catch (err) {
        reply(err instanceof Error ? err : new Error(String(err)), true);
      }
      return;
    }

    if (isReply(msg)) {
      // 服务端对握手请求的应答：ret === 'server'，此时记下自己的编号
      if (msg.id !== HANDSHAKE_ID && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(msg.ret instanceof Error ? msg.ret : new Error(String(msg.ret)));
        else p.resolve(msg.ret);
      }
    }
  }

  /** 原生 → 宿主 调用 */
  call(cmd: string, args?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${cmd} 超时（${this.callTimeoutMs}ms）`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, type: 0, target: 0, cmd, args } satisfies Envelope);
    });
  }

  /** 测试用：手动指定自己的编号（真实实现由服务端分配） */
  setClientNo(n: number): void {
    this.myClientNo = n;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
