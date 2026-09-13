import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { migrate } from './schema';
import type { TextEntry, EntryStatus } from '@shared/contracts';

/**
 * 文本库（platform 层基础设施）—— 抽取 / 翻译 / 回写 的中央数据层。
 *
 * 它承担三件事：
 *  1. 持久化抽取结果（幂等：同一 (path,key) 重抽不重复）
 *  2. 用 src_hash 检测"原文变了"，自动把条目打回 pending（不漏翻）
 *  3. 全文检索（FTS5 trigram，中日文可搜子串）
 */

export interface UpsertResult {
  /** 新条目 */
  inserted: number;
  /** 已存在且原文未变（仅刷新元数据） */
  refreshed: number;
  /** 已存在但原文变了 → 译文清空、状态回到 pending */
  invalidated: number;
}

export interface EntryQuery {
  status?: EntryStatus;
  engine?: string;
  limit?: number;
  offset?: number;
}

export interface StoreStats {
  total: number;
  byStatus: Record<EntryStatus, number>;
}

export interface GameMeta {
  title?: string;
  dir?: string;
  engineId?: string;
  engineVersion?: string;
}

/** 原文指纹：用于检测原文变更 */
export function hashSource(source: string): string {
  return createHash('sha1').update(source, 'utf8').digest('hex');
}

interface Row {
  id: number;
  game_id: string;
  engine: string;
  path: string;
  key: string;
  src_hash: string;
  source: string;
  translated: string | null;
  status: EntryStatus;
  session: string | null;
  context: string | null;
  extra: string | null;
}

function toEntry(r: Row): TextEntry {
  return {
    engine: r.engine,
    path: r.path,
    key: r.key,
    source: r.source,
    translated: r.translated ?? undefined,
    status: r.status,
    context: r.context ?? undefined,
    extra: r.extra ? (JSON.parse(r.extra) as Record<string, unknown>) : undefined,
  };
}

export class TextStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    migrate(this.db);
  }

  close(): void {
    this.db.close();
  }

  /** 确保游戏记录存在（upsert 的前置）。 */
  ensureGame(gameId: string, meta: GameMeta = {}): void {
    this.db
      .prepare('INSERT OR IGNORE INTO game(id,title,dir,engine_id,engine_version,added_at) VALUES(?,?,?,?,?,?)')
      .run(gameId, meta.title ?? gameId, meta.dir ?? '', meta.engineId ?? null, meta.engineVersion ?? null, Date.now());
  }

  getGame(gameId: string): (GameMeta & { id: string; addedAt: number }) | undefined {
    const r = this.db
      .prepare('SELECT id,title,dir,engine_id,engine_version,added_at FROM game WHERE id=?')
      .get(gameId) as
      | { id: string; title: string; dir: string; engine_id: string | null; engine_version: string | null; added_at: number }
      | undefined;
    if (!r) return undefined;
    return {
      id: r.id,
      title: r.title,
      dir: r.dir,
      engineId: r.engine_id ?? undefined,
      engineVersion: r.engine_version ?? undefined,
      addedAt: r.added_at,
    };
  }

  /**
   * 写入抽取结果。幂等：同一 (gameId, path, key) 不会产生重复。
   * 原文变更的条目会被自动打回 pending 并清空译文。
   */
  upsert(gameId: string, entries: readonly TextEntry[], opts: { session?: string } = {}): UpsertResult {
    this.ensureGame(gameId);

    const existing = new Map<string, string>();
    const rows = this.db
      .prepare('SELECT path,key,src_hash FROM text_entry WHERE game_id=?')
      .all(gameId) as Array<{ path: string; key: string; src_hash: string }>;
    for (const r of rows) existing.set(`${r.path}\u0000${r.key}`, r.src_hash);

    const stmt = this.db.prepare(`
      INSERT INTO text_entry
        (game_id,engine,path,key,src_hash,source,translated,status,session,context,extra,updated_at)
      VALUES
        (@gameId,@engine,@path,@key,@srcHash,@source,NULL,'pending',@session,@context,@extra,@now)
      ON CONFLICT(game_id,path,key) DO UPDATE SET
        engine     = excluded.engine,
        session    = excluded.session,
        context    = excluded.context,
        extra      = excluded.extra,
        updated_at = excluded.updated_at,
        source     = CASE WHEN text_entry.src_hash <> excluded.src_hash THEN excluded.source ELSE text_entry.source END,
        src_hash   = excluded.src_hash,
        translated = CASE WHEN text_entry.src_hash <> excluded.src_hash THEN NULL ELSE text_entry.translated END,
        status     = CASE WHEN text_entry.src_hash <> excluded.src_hash THEN 'pending' ELSE text_entry.status END
    `);

    const result: UpsertResult = { inserted: 0, refreshed: 0, invalidated: 0 };
    const now = Date.now();
    const run = this.db.transaction((list: readonly TextEntry[]) => {
      for (const e of list) {
        const h = hashSource(e.source);
        const prev = existing.get(`${e.path}\u0000${e.key}`);
        if (prev === undefined) result.inserted++;
        else if (prev !== h) result.invalidated++;
        else result.refreshed++;
        stmt.run({
          gameId,
          engine: e.engine,
          path: e.path,
          key: e.key,
          srcHash: h,
          source: e.source,
          session: opts.session ?? null,
          context: e.context ?? null,
          extra: e.extra ? JSON.stringify(e.extra) : null,
          now,
        });
      }
    });
    run(entries);
    return result;
  }

  list(gameId: string, q: EntryQuery = {}): TextEntry[] {
    const where = ['game_id = @gameId'];
    const params: Record<string, unknown> = { gameId };
    if (q.status) { where.push('status = @status'); params.status = q.status; }
    if (q.engine) { where.push('engine = @engine'); params.engine = q.engine; }
    params.limit = q.limit ?? 1000;
    params.offset = q.offset ?? 0;
    const sql = `SELECT * FROM text_entry WHERE ${where.join(' AND ')} ORDER BY id LIMIT @limit OFFSET @offset`;
    return (this.db.prepare(sql).all(params) as Row[]).map(toEntry);
  }

  getEntry(gameId: string, path: string, key: string): TextEntry | undefined {
    const r = this.db
      .prepare('SELECT * FROM text_entry WHERE game_id=? AND path=? AND key=?')
      .get(gameId, path, key) as Row | undefined;
    return r ? toEntry(r) : undefined;
  }

  /** 写入译文。返回是否命中条目。 */
  setTranslation(
    gameId: string,
    path: string,
    key: string,
    translated: string | null,
    status: EntryStatus = 'translated',
  ): boolean {
    const r = this.db
      .prepare('UPDATE text_entry SET translated=?, status=?, updated_at=? WHERE game_id=? AND path=? AND key=?')
      .run(translated, translated === null ? 'pending' : status, Date.now(), gameId, path, key);
    return r.changes > 0;
  }

  /** 批量写入译文（回写流程用）。 */
  setTranslations(
    gameId: string,
    items: ReadonlyArray<{ path: string; key: string; translated: string | null; status?: EntryStatus }>,
  ): number {
    const run = this.db.transaction((list: typeof items) => {
      let n = 0;
      for (const it of list) {
        if (this.setTranslation(gameId, it.path, it.key, it.translated, it.status ?? 'translated')) n++;
      }
      return n;
    });
    return run(items);
  }

  stats(gameId: string): StoreStats {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM text_entry WHERE game_id=? GROUP BY status')
      .all(gameId) as Array<{ status: string; n: number }>;
    const byStatus = { pending: 0, translated: 0, reviewed: 0, conflict: 0 } as Record<EntryStatus, number>;
    let total = 0;
    for (const r of rows) {
      byStatus[r.status as EntryStatus] = r.n;
      total += r.n;
    }
    return { total, byStatus };
  }

  /**
   * 全文检索（原文或译文）。中日文子串搜索。
   * FTS5 的 trigram 分词器要求查询串 ≥ 3 字符，短查询自动退回 LIKE。
   */
  search(gameId: string, query: string, limit = 50): TextEntry[] {
    const q = query.trim();
    if (!q) return [];

    if (q.length >= 3) {
      // trigram 子串匹配；用双引号包成短语，内部双引号翻倍转义
      const phrase = `"${q.replace(/"/g, '""')}"`;
      try {
        const rows = this.db
          .prepare(
            `SELECT e.* FROM text_fts f JOIN text_entry e ON e.id = f.rowid
             WHERE text_fts MATCH @q AND e.game_id = @gameId LIMIT @limit`,
          )
          .all({ q: phrase, gameId, limit }) as Row[];
        if (rows.length > 0) return rows.map(toEntry);
      } catch {
        /* FTS 查询语法异常时退回 LIKE，不把错误抛给用户 */
      }
    }

    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    return (
      this.db
        .prepare(
          `SELECT * FROM text_entry
           WHERE game_id = @gameId AND (source LIKE @like ESCAPE '\\' OR translated LIKE @like ESCAPE '\\')
           ORDER BY id LIMIT @limit`,
        )
        .all({ gameId, like, limit }) as Row[]
    ).map(toEntry);
  }

  /**
   * 翻译记忆（TM）：按原文精确匹配，返回此前译过的译文。
   * 同游戏的命中优先，其次是其它游戏的（跨游戏复用常见短语，省钱）。
   */
  findTranslationBySource(source: string, gameId?: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT translated FROM text_entry
         WHERE source = @source
           AND translated IS NOT NULL AND translated <> ''
           AND status IN ('translated','reviewed')
         ORDER BY (game_id = @gameId) DESC, updated_at DESC
         LIMIT 1`,
      )
      .get({ source, gameId: gameId ?? '' }) as { translated: string } | undefined;
    return row?.translated;
  }

  /** 批量精确匹配：返回 source -> { 已有译文, 是否来自本游戏 }（TM 预过滤用，一次查完）。 */
  findTranslationsBySource(
    sources: readonly string[],
    gameId?: string,
  ): Map<string, { translated: string; sameGame: boolean }> {
    const out = new Map<string, { translated: string; sameGame: boolean }>();
    if (sources.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT source, translated, (game_id = @gameId) AS sameGame FROM text_entry
       WHERE source = @source
         AND translated IS NOT NULL AND translated <> ''
         AND status IN ('translated','reviewed')
       ORDER BY sameGame DESC, updated_at DESC
       LIMIT 1`,
    );
    const run = this.db.transaction((list: readonly string[]) => {
      for (const s of list) {
        const row = stmt.get({ source: s, gameId: gameId ?? '' }) as
          | { source: string; translated: string; sameGame: number }
          | undefined;
        if (row && !out.has(row.source)) {
          out.set(row.source, { translated: row.translated, sameGame: row.sameGame === 1 });
        }
      }
    });
    run(sources);
    return out;
  }

  /**
   * 取**已有的译文**集合 —— 用于"反向翻译记忆"防护。
   *
   * 为什么需要：静态回写会把译文写进游戏文件，于是"再抽一次"读到的其实是我们自己的输出。
   * 不过滤掉的话第二次运行会把中文当原文再翻一遍（【译】【译】…），毁掉游戏。
   *
   * 默认 **global（跨游戏）**：这样把游戏**复制到新目录**（gameId 会变）后也能识别出
   * "这其实是我们翻过的"，不会二次翻译 —— 实测踩过：复制已翻译的目录到新路径，
   * 只按 gameId 查会漏判，结果是 【中】【中】 双重翻译。
   * 代价：若将来做 zh→en，别处存的中文译文可能误命中 —— 那种场景传 'game' 收窄。
   */
  translatedSet(gameId: string, scope: 'global' | 'game' = 'global'): Set<string> {
    // 只收 translated / reviewed —— 这两种才是"确实写进过游戏文件"的译文。
    // conflict 没写回游戏，不该参与反向匹配。
    const rows = this.db
      .prepare(
        `SELECT DISTINCT translated FROM text_entry
         WHERE translated IS NOT NULL AND translated<>''
           AND status IN ('translated','reviewed')
           ${scope === 'game' ? 'AND game_id = ?' : ''}`,
      )
      .all(...(scope === 'game' ? [gameId] : [])) as Array<{ translated: string }>;
    return new Set(rows.map((r) => r.translated));
  }

  /** 删除某游戏的全部条目（game 表级联，但显式提供更清晰）。 */
  removeGame(gameId: string): number {
    const r = this.db.prepare('DELETE FROM game WHERE id=?').run(gameId);
    return r.changes;
  }

  /**
   * 环境自检：返回 SQLite 版本与 FTS 可用性。
   * 应用启动时可展示（"百宝箱"类的工具都需要一个自检页），也用于排查原生模块问题。
   */
  probe(): { sqliteVersion: string; ftsMatchOk: boolean; trigramOk: boolean } {
    const versionRow = this.db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    let ftsMatchOk = false;
    try {
      this.db.prepare('SELECT count(*) AS n FROM text_fts WHERE text_fts MATCH ?').get('"baibao_probe_xyz"');
      ftsMatchOk = true;
    } catch {
      ftsMatchOk = false;
    }
    // 表是按 trigram 建的：能建出来就说明该分词器可用
    let trigramOk = false;
    try {
      const sql = this.db
        .prepare("SELECT sql FROM sqlite_master WHERE name='text_fts'")
        .get() as { sql: string } | undefined;
      trigramOk = Boolean(sql?.sql.includes('trigram'));
    } catch {
      trigramOk = false;
    }
    return { sqliteVersion: versionRow.v, ftsMatchOk, trigramOk };
  }
}

/** 打开文本库（默认路径由调用方决定，便于测试注入临时库）。 */
export function openTextStore(dbPath: string): TextStore {
  return new TextStore(dbPath);
}
