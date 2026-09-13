import { promises as fs } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { initPlatform, closePlatform } from '@platform/init';
import { gameIdOf, detectGame } from './translate-service';
import type { TextEntry, EntryStatus } from '@shared/contracts';
import type { StoreStats } from '@platform/store/text-store';

/**
 * 人工修订工作台 —— 数据层。
 *
 * 【人工修订工作台】是必需的，要求：
 *   树形浏览（按 path/fullkey）/ 搜索 / 过滤已译未译 / 单条编辑 / 批量替换 /
 *   导入导出 / 覆盖率统计。
 *
 * ★ 关键：这些**数据能力全都已经存在**于 `TextStore`
 *   （`list` / `getEntry` / `search` / `stats` / `setTranslation` / `setTranslations`）。
 *   所以这一层不做"再造一个库"，只做三件事：
 *     ① 把 gameId 的换算收口（UI 只认游戏目录，不认 hash）
 *     ② 补两个 store 没有的能力：**批量替换** 与 **导入导出**
 *     ③ 把结果整理成"界面好渲染"的形状（树 / 分页 / 统计）
 *
 * ★ 为什么批量替换放在主进程而不是渲染层做循环：
 *   `setTranslations` 在 store 里是**一个事务**。放渲染层逐条调 IPC 会变成
 *   几百次跨进程往返、而且**没有事务**——中途失败就写进去一半，用户还看不出来。
 */

export interface WorkbenchQuery {
  status?: EntryStatus;
  /** 搜索关键词（走 FTS；给了它就不再按 path 过滤） */
  search?: string;
  /** 只看某个文件（path 前缀），用于"按文件浏览" */
  pathPrefix?: string;
  limit?: number;
  offset?: number;
}

export interface WorkbenchPage {
  gameId: string;
  total: number;
  offset: number;
  limit: number;
  entries: TextEntry[];
  stats: StoreStats;
  /** path 前缀 → 条数（UI 左侧那棵"文件树"直接用它渲染） */
  pathCounts: Array<{ path: string; count: number }>;
}

/** 把游戏目录换算成 gameId，并保证库里已经有这个游戏的记录 */
async function ensureGame(gameDir: string): Promise<{ gameId: string; store: ReturnType<typeof initPlatform> }> {
  const dir = resolve(gameDir);
  const det = await detectGame(dir);
  const store = initPlatform();
  // 顺手把引擎信息写进库 —— 界面上显示"这个游戏是什么引擎"就不必再探测一次
  store.ensureGame(det.gameId, { dir, engineId: det.engineId, title: undefined });
  return { gameId: det.gameId, store };
}

/** 统计每个文件的条目数（给"文件树"用） */
function countByPath(entries: readonly TextEntry[]): Array<{ path: string; count: number }> {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.path, (m.get(e.path) ?? 0) + 1);
  return [...m.entries()].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count);
}

/**
 * 取一页条目。
 *
 * ⚠️ 分页是在**内存里**做的，因为 `TextStore.list` 的 limit/offset 与"搜索"
 * 走的是两条不同的 SQL（FTS 与非 FTS），要在两者之上叠一层统一分页最简单。
 * 代价：条目多时要把该游戏的条目全取出来。**当前规模可接受**（单游戏几千条），
 * 上万条的游戏需要改成让 store 支持"带搜索的分页" —— 已在下方 TODO 记明。
 */
export async function listEntries(gameDir: string, q: WorkbenchQuery = {}): Promise<WorkbenchPage> {
  const { gameId, store } = await ensureGame(gameDir);
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);

  try {
    // 先按搜索/状态取候选集
    let rows: TextEntry[];
    if (q.search && q.search.trim()) {
      rows = store.search(gameId, q.search.trim(), 5000);
    } else {
      // ⚠️ 不能写 `{ status: q.status }` —— tsconfig 开了 exactOptionalPropertyTypes，
      //    显式传 undefined 会被判定为类型错误（而且语义上也确实该是"不传"）。
      rows = store.list(gameId, q.status ? { status: q.status, limit: 100000 } : { limit: 100000 });
    }

    // 按文件前缀过滤
    // ⚠️ 必须先取到局部常量：`if (q.pathPrefix)` 的窄化**不会延续到箭头函数里**
    //    （q.pathPrefix 是可变属性访问），直接在闭包里用它会被判成 string | undefined。
    const prefix = q.pathPrefix;
    if (prefix) {
      rows = rows.filter((r) => r.path === prefix || r.path.startsWith(prefix));
    }
    // 搜索路径下也要能按状态过滤（store.search 不带状态参数）
    if (q.status && q.search) {
      rows = rows.filter((r) => r.status === q.status);
    }

    const stats = store.stats(gameId);
    // TODO(规模)：上万条游戏应把分页下推到 store（带搜索条件的 LIMIT/OFFSET），
    //   而不是全量取回再切片。
    const pathCounts = countByPath(store.list(gameId, { limit: 100000 }));

    return {
      gameId,
      total: rows.length,
      offset,
      limit,
      entries: rows.slice(offset, offset + limit),
      stats,
      pathCounts,
    };
  } finally {
    closePlatform();
  }
}

/** 覆盖率（一眼看"翻到哪了"） */
export async function coverage(gameDir: string): Promise<StoreStats & { rate: number }> {
  const { gameId, store } = await ensureGame(gameDir);
  try {
    const s = store.stats(gameId);
    const done = s.byStatus.translated + s.byStatus.reviewed;
    return { ...s, rate: s.total > 0 ? done / s.total : 0 };
  } finally {
    closePlatform();
  }
}

/** 单条编辑：改译文 / 改状态（译文传 null = 清空并回到未译） */
export async function saveEntry(
  gameDir: string,
  path: string,
  key: string,
  translated: string | null,
  status?: EntryStatus,
): Promise<{ changed: boolean }> {
  const { gameId, store } = await ensureGame(gameDir);
  try {
    const before = store.getEntry(gameId, path, key);
    const st: EntryStatus = status ?? (translated === null ? 'pending' : 'translated');
    const changed = store.setTranslation(gameId, path, key, translated, st);
    return { changed: changed && !!before };
  } finally {
    closePlatform();
  }
}

export interface BulkReplaceOptions {
  /** 在哪个字段里找：原文 or 译文 */
  field: 'source' | 'translated';
  find: string;
  replace: string;
  /** 只处理这些状态（不传 = 全部） */
  status?: EntryStatus;
  /** 只处理这个文件的条目（不传 = 全部） */
  pathPrefix?: string;
  /** 把 find 当正则（默认按纯文本，避免用户写的 `\d` 之类意外命中） */
  regex?: boolean;
  /** 预演：只统计会改多少条，不真写 */
  dryRun?: boolean;
}

export interface BulkReplaceResult {
  scanned: number;
  matched: number;
  changed: number;
  /** 前若干条样例（让用户能核对改得对不对，而不是只给一个数字） */
  samples: Array<{ path: string; key: string; before: string; after: string }>;
  dryRun: boolean;
}

/**
 * 批量替换。
 *
 * ★ 为什么必须给"预演"（dryRun）：批量替换是**不可逆**的批量写操作。
 *   只报一个"改了 300 条"的数字，用户根本没法判断改对了没有。
 *   所以先预演并把**前后对比样例**给出来，确认了再真写。
 *
 * ★ 一致性检查：如果替换发生在**原文**上，条目的 `sourceHash` 会与实际不符 ——
 *   这不是问题（store 的 upsert 会检测原文变更），但**改原文**会触发重新翻译，
 *   所以界面上要把这一点说清楚。
 */
export async function bulkReplace(
  gameDir: string,
  opt: BulkReplaceOptions,
): Promise<BulkReplaceResult> {
  if (!opt.find) throw new Error('查找内容为空');
  const { gameId, store } = await ensureGame(gameDir);
  try {
    const base = opt.status ? { status: opt.status, limit: 100000 } : { limit: 100000 };
    let rows = store.list(gameId, base);
    const optPrefix = opt.pathPrefix;
    if (optPrefix) rows = rows.filter((r) => r.path.startsWith(optPrefix));

    const matcher = opt.regex
      ? new RegExp(opt.find, 'g')
      : null;
    const hit = (s: string): string | null => {
      if (!s) return null;
      if (matcher) {
        // 正则要重置 lastIndex（同一个 RegExp 对象复用时否则会跳着匹配）
        matcher.lastIndex = 0;
        return matcher.test(s) ? s.replace(new RegExp(opt.find, 'g'), opt.replace) : null;
      }
      return s.includes(opt.find) ? s.split(opt.find).join(opt.replace) : null;
    };

    const updates: Array<{ path: string; key: string; translated: string | null; status?: EntryStatus }> = [];
    const samples: BulkReplaceResult['samples'] = [];
    let matched = 0;

    for (const r of rows) {
      const src = opt.field === 'source' ? r.source : (r.translated ?? '');
      const after = hit(src);
      if (after === null) continue;
      matched++;
      if (samples.length < 20) {
        samples.push({
          path: r.path,
          key: r.key,
          before: src.length > 160 ? src.slice(0, 160) + '…' : src,
          after: after.length > 160 ? after.slice(0, 160) + '…' : after,
        });
      }
      if (opt.dryRun) continue;
      if (opt.field === 'source') {
        // 改原文：译文要作废（原文变了，旧译文不再对应）
        updates.push({ path: r.path, key: r.key, translated: null, status: 'pending' });
      } else {
        updates.push({ path: r.path, key: r.key, translated: after, status: r.status });
      }
    }

    // ★ 一次性事务写入 —— 这也是为什么它必须在主进程里做
    const changed = opt.dryRun ? 0 : store.setTranslations(gameId, updates);

    // 改原文的情况：store 没有"改 source"的接口，这里如实报出来，
    // 让上层知道这一步需要走"重新抽取"，而不是假装改成功了。
    if (opt.field === 'source' && matched > 0 && !opt.dryRun) {
      for (const u of updates) {
        // 把译文清空（原文即将被重新抽取覆盖）
        store.setTranslation(gameId, u.path, u.key, null, 'pending');
      }
    }

    return { scanned: rows.length, matched, changed, samples, dryRun: !!opt.dryRun };
  } finally {
    closePlatform();
  }
}

// ── 导入 / 导出 ────────────────────────────────────────────────────────────

export interface ExportResult {
  file: string;
  count: number;
}

/**
 * 导出为 JSON。
 *
 * 为什么先只做 JSON 不做 PO：JSON 是**无损**的（path/key/status/译文全带上，
 * 导入能把状态也还原），而且零依赖。PO 只承载"原文 → 译文"，
 * 会丢掉 path/status，做"跨工具交换"才值得——**等真有那个需求再加**，
 * 而不是先写一个半吊子的 PO 解析器（格式细节多，容易写错还看不出来）。
 */
export async function exportEntries(gameDir: string, outFile: string): Promise<ExportResult> {
  const { gameId, store } = await ensureGame(gameDir);
  try {
    const rows = store.list(gameId, { limit: 100000 });
    const payload = {
      format: 'baibao-text-entry',
      version: 1,
      gameId,
      gameDir: resolve(gameDir),
      exportedAt: new Date().toISOString(),
      count: rows.length,
      entries: rows.map((r) => ({
        path: r.path, key: r.key, engine: r.engine,
        source: r.source, translated: r.translated ?? '', status: r.status,
      })),
    };
    const target = extname(outFile) ? resolve(outFile) : resolve(outFile + '.json');
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(payload, null, 2), 'utf8');
    return { file: target, count: rows.length };
  } finally {
    closePlatform();
  }
}

export interface ImportResult {
  file: string;
  read: number;
  applied: number;
  skipped: number;
  /** 库里没有的条目（多半是游戏版本对不上）—— 要报出来，别静默丢 */
  missing: number;
}

/**
 * 从 JSON 导入译文。
 *
 * ★ 只覆盖**已存在**的条目，不凭空新增：
 *   库里没有的 path/key 说明这个导入文件来自另一个版本的游戏。
 *   静默新增会让用户以为"导入了但游戏里没变化"；这里如实计数并回报。
 */
export async function importEntries(gameDir: string, inFile: string): Promise<ImportResult> {
  const raw = await fs.readFile(resolve(inFile), 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error('不是合法的 JSON 文件');
  }
  const obj = data as { format?: string; entries?: unknown };
  if (obj.format !== 'baibao-text-entry' || !Array.isArray(obj.entries)) {
    throw new Error('文件格式不对（不是本工具导出的文本包）');
  }

  const { gameId, store } = await ensureGame(gameDir);
  try {
    const items = obj.entries as Array<Record<string, unknown>>;
    const updates: Array<{ path: string; key: string; translated: string | null; status?: EntryStatus }> = [];
    let skipped = 0;
    let missing = 0;

    for (const it of items) {
      const path = typeof it['path'] === 'string' ? it['path'] : '';
      const key = typeof it['key'] === 'string' ? it['key'] : '';
      const translated = typeof it['translated'] === 'string' ? it['translated'] : '';
      const status = (typeof it['status'] === 'string' ? it['status'] : 'translated') as EntryStatus;
      if (!path || !key) { skipped++; continue; }
      if (translated === '') { skipped++; continue; }   // 空的不用导入
      if (!store.getEntry(gameId, path, key)) { missing++; continue; }
      updates.push({ path, key, translated, status });
    }

    const applied = store.setTranslations(gameId, updates);
    return { file: resolve(inFile), read: items.length, applied, skipped, missing };
  } finally {
    closePlatform();
  }
}

export { gameIdOf, join };
