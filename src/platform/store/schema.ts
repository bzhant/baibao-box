import type { Database } from 'better-sqlite3';

/**
 * 文本库 schema 与迁移。
 *
 * 设计要点：
 *  - `text_entry` 以 (game_id, path, key) 唯一 —— 抽取是幂等的，重抽不会产生重复条目。
 *  - 存 `src_hash`（原文指纹）：原文变了就把译文清空、状态打回 pending，**自动标记需重译**。
 *    这是"游戏更新后不漏翻"的关键。
 *  - FTS5 用 **trigram** 分词器而不是默认的 unicode61：unicode61 会把一整串中日文
 *    当成一个 token，导致"搜中间几个字"搜不到；trigram 支持子串匹配，适合中日文检索。
 *  - FTS 用 external content + 触发器同步，不额外占空间、也不会和主表不一致。
 */

export const SCHEMA_VERSION = 1;

const MIGRATION_1 = `
CREATE TABLE IF NOT EXISTS game (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  dir            TEXT NOT NULL,
  engine_id      TEXT,
  engine_version TEXT,
  cover_path     TEXT,
  added_at       INTEGER NOT NULL,
  last_played_at INTEGER
);

CREATE TABLE IF NOT EXISTS text_entry (
  id         INTEGER PRIMARY KEY,
  game_id    TEXT NOT NULL REFERENCES game(id) ON DELETE CASCADE,
  engine     TEXT NOT NULL,
  path       TEXT NOT NULL,
  key        TEXT NOT NULL,
  src_hash   TEXT NOT NULL,
  source     TEXT NOT NULL,
  translated TEXT,
  status     TEXT NOT NULL DEFAULT 'pending',
  session    TEXT,
  context    TEXT,
  extra      TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (game_id, path, key)
);

CREATE INDEX IF NOT EXISTS idx_entry_game_status ON text_entry(game_id, status);
CREATE INDEX IF NOT EXISTS idx_entry_game_engine ON text_entry(game_id, engine);

CREATE VIRTUAL TABLE IF NOT EXISTS text_fts USING fts5(
  source, translated,
  content='text_entry', content_rowid='id',
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS text_entry_ai AFTER INSERT ON text_entry BEGIN
  INSERT INTO text_fts(rowid, source, translated) VALUES (new.id, new.source, new.translated);
END;
CREATE TRIGGER IF NOT EXISTS text_entry_ad AFTER DELETE ON text_entry BEGIN
  INSERT INTO text_fts(text_fts, rowid, source, translated) VALUES ('delete', old.id, old.source, old.translated);
END;
CREATE TRIGGER IF NOT EXISTS text_entry_au AFTER UPDATE ON text_entry BEGIN
  INSERT INTO text_fts(text_fts, rowid, source, translated) VALUES ('delete', old.id, old.source, old.translated);
  INSERT INTO text_fts(rowid, source, translated) VALUES (new.id, new.source, new.translated);
END;
`;

/** 建表/迁移。幂等，可重复调用。 */
export function migrate(db: Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const current = db.pragma('user_version', { simple: true }) as number;
  if (current < 1) {
    db.exec(MIGRATION_1);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  // 后续版本在这里继续追加： if (current < 2) { db.exec(MIGRATION_2); ... }
}
