import { describe, it, expect } from 'vitest';
import { encodeGraph, decodeGraph, stringifyGraph, parseGraph, GRAPH_MARK } from './graph';

/** 往返：编码 → JSON → 解码 */
function roundTrip<T>(v: T): T {
  return parseGraph(stringifyGraph(v)) as T;
}

describe('对象图序列化（往返测试）', () => {
  it('原始值：字符串 / 布尔 / null / undefined', () => {
    expect(roundTrip('hello')).toBe('hello');
    expect(roundTrip('')).toBe('');
    expect(roundTrip(true)).toBe(true);
    expect(roundTrip(false)).toBe(false);
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it('★ 特殊数字不会丢：NaN / Infinity / -Infinity / -0', () => {
    // 裸 JSON 会把它们全变成 null —— 这是必须自己实现序列化的直接原因
    expect(Number.isNaN(roundTrip(NaN))).toBe(true);
    expect(roundTrip(Infinity)).toBe(Infinity);
    expect(roundTrip(-Infinity)).toBe(-Infinity);
    expect(Object.is(roundTrip(-0), -0)).toBe(true);
    expect(roundTrip(0)).toBe(0);
    expect(roundTrip(3.14)).toBe(3.14);
    expect(roundTrip(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('BigInt', () => {
    expect(roundTrip(12345678901234567890n)).toBe(12345678901234567890n);
  });

  it('嵌套对象与数组', () => {
    const v = { a: 1, b: { c: [1, 'two', null, { d: true }] }, e: [] };
    expect(roundTrip(v)).toEqual(v);
  });

  it('★ 循环引用（自引用 + 互引用）', () => {
    const self: Record<string, unknown> = { name: 'self' };
    self.me = self;
    const r1 = roundTrip(self);
    expect(r1.name).toBe('self');
    expect(r1.me).toBe(r1); // 必须指回自己

    const a: Record<string, unknown> = { name: 'a' };
    const b: Record<string, unknown> = { name: 'b', a };
    a.b = b;
    const r2 = roundTrip(a) as Record<string, unknown>;
    const rb = r2.b as Record<string, unknown>;
    expect(rb.a).toBe(r2); // 互相指
  });

  it('★ 共享引用保持同一性（同一对象出现两次）', () => {
    const shared = { x: 1 };
    const v = { p: shared, q: shared };
    const r = roundTrip(v);
    expect(r.p).toBe(r.q); // 解码后仍是同一个对象
    expect(r.p).not.toBe(v.p); // 但确实被复制了一次
  });

  it('★ Error 无损：name / message / stack / cause 链', () => {
    const root = new Error('最外层失败');
    root.name = 'OuterError';
    const inner = new Error('内层原因');
    (root as Error & { cause?: unknown }).cause = inner;

    const r = roundTrip(root) as Error & { cause?: Error };
    expect(r).toBeInstanceOf(Error);
    expect(r.name).toBe('OuterError');
    expect(r.message).toBe('最外层失败');
    expect(r.stack).toContain('最外层失败'); // stack 保留
    expect(r.cause).toBeInstanceOf(Error);
    expect((r.cause as Error).message).toBe('内层原因');
  });

  it('Error 上的自定义字段也保留', () => {
    const e = new Error('boom') as Error & { code?: string };
    e.code = 'E_FAIL';
    const r = roundTrip(e) as Error & { code?: string };
    expect(r.code).toBe('E_FAIL');
  });

  it('Map / Set / Date / RegExp', () => {
    const m = new Map<unknown, unknown>([
      ['k', 1],
      [{ objKey: true }, 'object-key'],
    ]);
    const rm = roundTrip(m);
    expect(rm).toBeInstanceOf(Map);
    expect(rm.get('k')).toBe(1);
    expect([...rm.keys()].some((k) => (k as { objKey?: boolean }).objKey === true)).toBe(true);

    const s = roundTrip(new Set([1, 'a', null]));
    expect(s).toBeInstanceOf(Set);
    expect(s.has(1) && s.has('a') && s.has(null)).toBe(true);

    expect(roundTrip(new Date('2026-09-13T02:00:00.000Z')).toISOString()).toBe(
      '2026-09-13T02:00:00.000Z',
    );

    const re = roundTrip(/ab+c/gi);
    expect(re).toBeInstanceOf(RegExp);
    expect(re.source).toBe('ab+c');
    expect(re.flags).toBe('gi');
  });

  it('Map 的循环引用也能还原', () => {
    const m = new Map<string, unknown>();
    m.set('self', m);
    const r = roundTrip(m);
    expect(r.get('self')).toBe(r);
  });

  it('数组上的自定义属性（extra）', () => {
    const arr = [1, 2] as number[] & { tag?: string };
    arr.tag = 'x';
    const r = roundTrip(arr) as number[] & { tag?: string };
    expect([...r]).toEqual([1, 2]); // 注意：不能用 toEqual([1,2])，extra 属性会被一起比进去
    expect(r.tag).toBe('x');
  });

  it('函数与 symbol 被丢弃成 undefined（不可搬运）', () => {
    const r = roundTrip({ f: () => 1, s: Symbol('x'), keep: 1 }) as Record<string, unknown>;
    expect(r.f).toBeUndefined();
    expect(r.s).toBeUndefined();
    expect(r.keep).toBe(1);
  });

  it('深嵌套不爆栈（1000 层）', () => {
    let v: Record<string, unknown> = { end: true };
    for (let i = 0; i < 1000; i++) v = { next: v };
    let r = roundTrip(v) as Record<string, unknown>;
    let depth = 0;
    while (r.next) {
      r = r.next as Record<string, unknown>;
      depth++;
    }
    expect(depth).toBe(1000);
  });

  it('格式自描述：带标记 + 引用表', () => {
    const g = encodeGraph({ a: { b: 1 } });
    expect(g[GRAPH_MARK]).toBe(true);
    expect(Array.isArray(g.refs)).toBe(true);
    expect(g.refs.length).toBe(2); // 外层 + 内层
  });

  it('拒绝非对象图格式的输入（不静默吃下）', () => {
    expect(() => decodeGraph({ a: 1 } as never)).toThrow(/isRefsSerialized/);
  });

  it('引用越界会明确报错', () => {
    expect(() =>
      decodeGraph({ [GRAPH_MARK]: true, root: { k: 'r', i: 99 }, refs: [] } as never),
    ).toThrow(/越界/);
  });
});
