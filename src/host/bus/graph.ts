/**
 * 对象图序列化（原生侧 ↔ 宿主侧的跨进程搬运格式）。
 *
 * 为什么不能用 `JSON.stringify`：宿主和 hook DLL 之间要来回传的**不是纯数据** ——
 * 里面有 Error（要带完整 stack 便于溯源）、Map、Set、循环引用、
 * 同一个对象被多处引用（保持同一性）、NaN/Infinity/BigInt。
 * 裸 JSON 会把这些全丢掉或直接抛错。
 *
 * 格式（自描述 + 显式引用表，**无歧义**）：
 *
 *   { isRefsSerialized: true, root: Encoded, refs: GraphNode[] }
 *
 * 每个"值"都是一个带标签的 Encoded：
 *   {k:'s',v}  字符串      {k:'n',v}  数字（含 'NaN'/'Infinity'/'-Infinity'/'-0'）
 *   {k:'b',v}  布尔        {k:'z'}    null        {k:'u'} undefined
 *   {k:'i',v}  BigInt（十进制字符串）   {k:'r',i} 指向 refs[i] 的引用
 *
 * 引用表让**循环引用**与**共享引用**都能无损往返；`refs` 里每个节点形如：
 *   {k:'obj',c,p} 普通对象（c=构造函数名，仅供诊断，**解码不回填原型**）
 *   {k:'arr',i,extra?}  数组（extra 保留挂在数组上的自定义属性）
 *   {k:'map',e} {k:'set',i} {k:'date',v} {k:'regexp',s,f}
 *   {k:'error',name,message,stack?,cause?,p?}
 *
 * ⚠️ 数字必须走 `{k:'n'}`：`JSON.stringify(NaN)` 会变成 `null`，
 * 直接用裸 number 表达会和"引用索引"混淆。
 */

export const GRAPH_MARK = 'isRefsSerialized' as const;

/**
 * 线格式：对象图（默认）或**简易 JSON**。
 *
 * 简易格式是给"没有对象图能力的对端"用的（目前是 C++ 原生侧）。
 * 为什么不让 C++ 也实现一遍对象图：这条链路只搬字符串/数字/布尔/数组/对象，
 * 用不上引用表、Map、循环引用；为了它们把整套格式在 C++ 里复制一份，
 * 是纯粹的双份维护负担，且极容易两边不一致。
 *
 * 代价是**丢掉了 Error 的 stack 与循环引用** —— 所以错误在简易格式里
 * 降级成 `{name,message,stack}` 这样的普通对象（见 `encodePlain`）。
 * 谁用哪种格式，由连接方在 WebSocket 握手时显式声明（连 `/plain`）。
 */
export type WireFormat = 'graph' | 'plain';

/** 这段已解析的 JSON 是不是对象图格式？（自描述，靠标记字段认） */
export function isGraphWire(parsed: unknown): boolean {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as Record<string, unknown>)[GRAPH_MARK] === true
  );
}

/**
 * 把值转成简易格式能表达的东西（就是裸 JSON 能表达的那几样）。
 *
 * - `Error` → `{name,message,stack}`：否则 JSON.stringify 出来是 `{}`，
 *   对端会看到"错误但没有任何信息"，比不报错还糟；
 * - `undefined` → `null`：JSON 对 undefined 的处理是"对象里直接丢掉、
 *   数组里变 null"，语义含糊；显式转 null 至少是确定的；
 * - `NaN` / `Infinity` → 字符串：JSON 会把它们变成 `null`，同样丢信息。
 */
export function encodePlain(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (v instanceof Error) {
    return { name: v.name, message: v.message, stack: v.stack ?? '' };
  }
  if (Array.isArray(v)) return v.map(encodePlain);
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = encodePlain(val);
    return out;
  }
  return v;
}

export type Encoded =
  | { k: 's'; v: string }
  | { k: 'n'; v: number | 'NaN' | 'Infinity' | '-Infinity' | '-0' }
  | { k: 'b'; v: boolean }
  | { k: 'z' }
  | { k: 'u' }
  | { k: 'i'; v: string }
  | { k: 'r'; i: number };

export type GraphNode =
  | { k: 'obj'; c: string; p: Record<string, Encoded> }
  | { k: 'arr'; i: Encoded[]; extra?: Record<string, Encoded> }
  | { k: 'map'; e: Array<[Encoded, Encoded]> }
  | { k: 'set'; i: Encoded[] }
  | { k: 'date'; v: string }
  | { k: 'regexp'; s: string; f: string }
  | {
      k: 'error';
      name: string;
      message: string;
      stack?: string;
      cause?: Encoded;
      p?: Record<string, Encoded>;
    };

export interface Graph {
  isRefsSerialized: true;
  root: Encoded;
  refs: GraphNode[];
}

const encUndef = (): Encoded => ({ k: 'u' });

/** 把任意值编码成对象图 */
export function encodeGraph(value: unknown): Graph {
  const refs: GraphNode[] = [];
  const seen = new Map<object, number>();

  const enc = (v: unknown): Encoded => {
    if (v === undefined) return encUndef();
    if (v === null) return { k: 'z' };
    const t = typeof v;
    if (t === 'string') return { k: 's', v: v as string };
    if (t === 'boolean') return { k: 'b', v: v as boolean };
    if (t === 'number') {
      const n = v as number;
      if (Number.isNaN(n)) return { k: 'n', v: 'NaN' };
      if (n === Infinity) return { k: 'n', v: 'Infinity' };
      if (n === -Infinity) return { k: 'n', v: '-Infinity' };
      if (Object.is(n, -0)) return { k: 'n', v: '-0' };
      return { k: 'n', v: n };
    }
    if (t === 'bigint') return { k: 'i', v: (v as bigint).toString() };
    if (t === 'function' || t === 'symbol') return encUndef(); // 不可搬运

    const obj = v as object;
    const hit = seen.get(obj);
    if (hit !== undefined) return { k: 'r', i: hit };

    const idx = refs.length;
    seen.set(obj, idx);
    refs.push({ k: 'obj', c: 'Object', p: {} }); // 占位，稍后覆盖（保证循环引用拿得到索引）

    let node: GraphNode;
    if (Array.isArray(obj)) {
      const extra: Record<string, Encoded> = {};
      for (const key of Object.keys(obj)) {
        if (/^\d+$/.test(key)) continue;
        extra[key] = enc((obj as unknown as Record<string, unknown>)[key]);
      }
      node = {
        k: 'arr',
        i: (obj as unknown[]).map(enc),
        ...(Object.keys(extra).length ? { extra } : {}),
      };
    } else if (obj instanceof Date) {
      node = { k: 'date', v: obj.toISOString() };
    } else if (obj instanceof RegExp) {
      node = { k: 'regexp', s: obj.source, f: obj.flags };
    } else if (obj instanceof Map) {
      node = {
        k: 'map',
        e: [...obj.entries()].map(([a, b]) => [enc(a), enc(b)] as [Encoded, Encoded]),
      };
    } else if (obj instanceof Set) {
      node = { k: 'set', i: [...obj.values()].map(enc) };
    } else if (obj instanceof Error) {
      const extra: Record<string, Encoded> = {};
      for (const key of Object.keys(obj)) {
        if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
        extra[key] = enc((obj as unknown as Record<string, unknown>)[key]);
      }
      node = {
        k: 'error',
        name: obj.name,
        message: obj.message,
        ...(obj.stack ? { stack: obj.stack } : {}),
        ...('cause' in obj && obj.cause !== undefined ? { cause: enc(obj.cause) } : {}),
        ...(Object.keys(extra).length ? { p: extra } : {}),
      };
    } else {
      const props: Record<string, Encoded> = {};
      for (const key of Object.keys(obj)) {
        props[key] = enc((obj as Record<string, unknown>)[key]);
      }
      const ctor = (obj as { constructor?: { name?: string } }).constructor?.name;
      node = { k: 'obj', c: ctor && ctor !== 'Object' ? ctor : 'Object', p: props };
    }

    refs[idx] = node;
    return { k: 'r', i: idx };
  };

  const root = enc(value);
  return { [GRAPH_MARK]: true, root, refs } as Graph;
}

/** 解码对象图。两趟走：先建空壳，再填内容 —— 这样循环引用也能正确还原。 */
export function decodeGraph(graph: Graph): unknown {
  if (!graph || graph[GRAPH_MARK] !== true) {
    throw new Error('不是对象图格式（缺 isRefsSerialized 标记）');
  }
  const nodes = graph.refs ?? [];
  const built: unknown[] = new Array(nodes.length).fill(undefined);

  const dec = (e: Encoded): unknown => {
    switch (e.k) {
      case 's':
        return e.v;
      case 'b':
        return e.v;
      case 'z':
        return null;
      case 'u':
        return undefined;
      case 'i':
        return BigInt(e.v);
      case 'n':
        if (e.v === 'NaN') return NaN;
        if (e.v === 'Infinity') return Infinity;
        if (e.v === '-Infinity') return -Infinity;
        if (e.v === '-0') return -0;
        return e.v;
      case 'r': {
        if (e.i < 0 || e.i >= nodes.length) throw new Error(`引用越界: refs[${e.i}]`);
        if (built[e.i] !== undefined) return built[e.i];
        const shell = shellOf(nodes[e.i]);
        built[e.i] = shell; // 先放空壳，防循环
        fill(nodes[e.i], shell);
        return shell;
      }
      default:
        throw new Error(`未知的编码类型: ${JSON.stringify(e)}`);
    }
  };

  const shellOf = (n: GraphNode): unknown => {
    switch (n.k) {
      case 'arr':
        return [];
      case 'map':
        return new Map();
      case 'set':
        return new Set();
      case 'date':
        return new Date(n.v);
      case 'regexp':
        return new RegExp(n.s, n.f);
      case 'error': {
        const err = new Error(n.message);
        err.name = n.name;
        if (n.stack) err.stack = n.stack;
        return err;
      }
      default:
        return {};
    }
  };

  const fill = (n: GraphNode, target: unknown): void => {
    switch (n.k) {
      case 'arr': {
        const arr = target as unknown[];
        for (const item of n.i) arr.push(dec(item));
        for (const [k, v] of Object.entries(n.extra ?? {})) {
          (arr as unknown as Record<string, unknown>)[k] = dec(v);
        }
        break;
      }
      case 'map': {
        const m = target as Map<unknown, unknown>;
        for (const [k, v] of n.e) m.set(dec(k), dec(v));
        break;
      }
      case 'set': {
        const s = target as Set<unknown>;
        for (const item of n.i) s.add(dec(item));
        break;
      }
      case 'error': {
        const err = target as Error & { cause?: unknown };
        if (n.cause) err.cause = dec(n.cause);
        for (const [k, v] of Object.entries(n.p ?? {})) {
          (err as unknown as Record<string, unknown>)[k] = dec(v);
        }
        break;
      }
      case 'obj': {
        const o = target as Record<string, unknown>;
        for (const [k, v] of Object.entries(n.p)) o[k] = dec(v);
        break;
      }
      default:
        break; // date / regexp 已在 shell 阶段构造完成
    }
  };

  return dec(graph.root);
}

/** 便捷：编码 → JSON 文本 */
export function stringifyGraph(value: unknown): string {
  return JSON.stringify(encodeGraph(value));
}

/** 便捷：JSON 文本 → 解码 */
export function parseGraph(text: string): unknown {
  return decodeGraph(JSON.parse(text) as Graph);
}
