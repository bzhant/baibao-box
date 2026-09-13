import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BusServer, BusClient } from './bus';
import { missingTaskHandleMessage } from './protocol';

let server: BusServer | null = null;
let clients: BusClient[] = [];

/** 起一个服务端 + 一个完成握手的客户端 */
async function setup(stateDir?: string): Promise<{ server: BusServer; client: BusClient; no: number }> {
  server = new BusServer({ stateDir, callTimeoutMs: 3000 });
  const { uri } = await server.listen();
  const client = new BusClient({ exePath: 'C:/games/x/Game.exe', pid: 1234, module: 'mvmzHook', arch: 64 });
  clients.push(client);
  await client.connect(uri);
  const { no } = await server.waitForClient(3000);
  return { server, client, no };
}

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  await server?.close();
  server = null;
});

describe('本地 RPC 总线', () => {
  it('起服务并返回 ws:// 地址', async () => {
    server = new BusServer();
    const { port, uri } = await server.listen();
    expect(port).toBeGreaterThan(0);
    expect(uri).toBe(`ws://127.0.0.1:${port}`);
  });

  it('★ 端口探测：17872 被占用时自动 +1，并把结果写进状态文件', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'baibao-bus-'));
    // 先占住一个端口
    const squatter = createServer();
    await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', () => r()));
    const busy = (squatter.address() as { port: number }).port;

    server = new BusServer({ port: busy, stateDir: dir });
    const { port } = await server.listen();

    expect(port).toBeGreaterThan(busy); // 换到了后面的端口
    expect(await fs.readFile(join(dir, 'listenPort'), 'utf8')).toBe(String(port));
    expect(await fs.readFile(join(dir, 'serverURI'), 'utf8')).toBe(`ws://127.0.0.1:${port}`);

    await new Promise<void>((r) => squatter.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('★ 握手：服务端 whoareyou → 客户端上报身份', async () => {
    const { server: s } = await setup();
    const list = s.clients();
    expect(list).toHaveLength(1);
    expect(list[0].identity.pid).toBe(1234);
    expect(list[0].identity.module).toBe('mvmzHook');
    expect(list[0].identity.arch).toBe(64);
  });

  it('★ 原生 → 宿主 调用：拿回结果', async () => {
    const { server: s, client } = await setup();
    s.handle('translate', (args) => {
      const { text } = args as { text: string };
      return { translated: `【译】${text}` };
    });
    const r = (await client.call('translate', { text: 'こんにちは' })) as { translated: string };
    expect(r.translated).toBe('【译】こんにちは');
  });

  it('★ 宿主 → 原生 反向调用（双向 RPC）', async () => {
    const { server: s, client } = await setup();
    client.handle('getTexts', () => ['第一句', '第二句']);
    const r = await s.callClient(1, 'getTexts');
    expect(r).toEqual(['第一句', '第二句']);
  });

  it('★ 未注册的 cmd → 明确报错（含 "(Client N)Missing taskHandle"）', async () => {
    const { client } = await setup();
    await expect(client.call('根本不存在')).rejects.toThrow(
      /Missing taskHandle: 根本不存在/,
    );
    try {
      await client.call('另一个不存在的');
    } catch (err) {
      expect((err as Error).message).toBe(missingTaskHandleMessage(1, '另一个不存在的'));
    }
  });

  it('★ handler 抛出的 Error 能带 stack 过网线', async () => {
    const { server: s, client } = await setup();
    s.handle('boom', () => {
      throw new Error('内部炸了');
    });
    try {
      await client.call('boom');
      throw new Error('不该走到这');
    } catch (err) {
      const e = err as Error;
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe('内部炸了');
      expect(e.stack).toContain('内部炸了'); // stack 必须一起送回来
    }
  });

  it('★ args 里的复杂值能过网线：循环引用 / Map / NaN / BigInt / Date', async () => {
    const { server: s, client } = await setup();
    let seen: unknown;
    s.handle('echo', (args) => {
      seen = args;
      return args;
    });

    const cyclic: Record<string, unknown> = { name: 'x' };
    cyclic.self = cyclic;
    const payload = {
      cyclic,
      m: new Map([['k', 1]]),
      nan: NaN,
      big: 10n,
      d: new Date('2026-09-13T02:00:00.000Z'),
      arr: [1, 'two', null],
    };

    const back = (await client.call('echo', payload)) as typeof payload;
    expect((seen as typeof payload).cyclic.self).toBe((seen as typeof payload).cyclic);
    expect(Number.isNaN((seen as typeof payload).nan)).toBe(true);
    expect((seen as typeof payload).big).toBe(10n);
    expect((seen as typeof payload).m.get('k')).toBe(1);
    expect(back.d.toISOString()).toBe('2026-09-13T02:00:00.000Z');
    expect(back.arr).toEqual([1, 'two', null]);
  });

  it('广播到所有客户端', async () => {
    const { server: s, client } = await setup();
    const { uri } = await s.listen().then(() => ({ uri: s.uri }));
    const c2 = new BusClient({ pid: 2 });
    clients.push(c2);
    await c2.connect(uri);
    await s.waitForClient(3000);
    // 等第二个客户端也完成握手
    await new Promise((r) => setTimeout(r, 50));

    client.handle('ping', () => 'pong-1');
    c2.handle('ping', () => 'pong-2');
    const rs = await s.broadcast('ping');
    expect(rs.sort()).toEqual(['pong-1', 'pong-2']);
  });

  it('调用超时：明确报错，不会永远挂着', async () => {
    const { server: s } = await setup();
    s.handle('slow', async () => {
      await new Promise((r) => setTimeout(r, 500));
      return 'done';
    });
    // 客户端侧超时压到 80ms，服务端 handler 要 500ms → 必然超时
    const quick = new BusClient({ pid: 9 }, 80);
    clients.push(quick);
    await quick.connect(s.uri);
    await expect(quick.call('slow')).rejects.toThrow(/超时/);
  });

  it('服务端 close 后连接被清理', async () => {
    const { server: s } = await setup();
    expect(s.clients()).toHaveLength(1);
    await s.close();
    expect(s.clients()).toHaveLength(0);
    server = null; // 已关，避免 afterEach 重复关
  });
});
