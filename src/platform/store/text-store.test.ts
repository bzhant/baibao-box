import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextStore, hashSource } from './text-store';
import type { TextEntry } from '@shared/contracts';

/** 文本库集成测试：真实 SQLite（含 FTS5 trigram + 触发器同步）。 */

function e(path: string, key: string, source: string, extra?: Record<string, unknown>): TextEntry {
  return { engine: 'mvmz', path, key, source, status: 'pending', extra };
}

describe('TextStore', () => {
  let store: TextStore;

  beforeEach(() => {
    store = new TextStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('首次 upsert 全部为新条目', () => {
    const r = store.upsert('g1', [
      e('data/Actors.json#/1/name', 'name', 'アーサー'),
      e('data/Items.json#/1/name', 'name', 'ポーション'),
      e('data/CommonEvents.json#/1/list/1/parameters/0', 'cmd401', 'こんにちは、\\N[1]！'),
    ]);
    expect(r).toEqual({ inserted: 3, refreshed: 0, invalidated: 0 });
    expect(store.stats('g1')).toEqual({
      total: 3,
      byStatus: { pending: 3, translated: 0, reviewed: 0, conflict: 0 },
    });
  });

  it('重抽同一批是幂等的（不产生重复）', () => {
    const entries = [
      e('data/Actors.json#/1/name', 'name', 'アーサー'),
      e('data/Items.json#/1/name', 'name', 'ポーション'),
    ];
    store.upsert('g1', entries);
    const r2 = store.upsert('g1', entries);
    expect(r2).toEqual({ inserted: 0, refreshed: 2, invalidated: 0 });
    expect(store.stats('g1').total).toBe(2);
  });

  it('原文变更 → 译文清空、状态打回 pending（不漏翻）', () => {
    store.upsert('g1', [e('p1', 'name', '旧原文')]);
    store.setTranslation('g1', 'p1', 'name', '旧译文');
    expect(store.getEntry('g1', 'p1', 'name')?.status).toBe('translated');

    const r = store.upsert('g1', [e('p1', 'name', '新原文')]);
    expect(r).toEqual({ inserted: 0, refreshed: 0, invalidated: 1 });

    const row = store.getEntry('g1', 'p1', 'name');
    expect(row?.source).toBe('新原文');
    expect(row?.translated).toBeUndefined();
    expect(row?.status).toBe('pending');
  });

  it('原文未变时保留译文', () => {
    store.upsert('g1', [e('p1', 'name', '原文')]);
    store.setTranslation('g1', 'p1', 'name', '译文');
    store.upsert('g1', [e('p1', 'name', '原文')]);
    const row = store.getEntry('g1', 'p1', 'name');
    expect(row?.translated).toBe('译文');
    expect(row?.status).toBe('translated');
  });

  it('setTranslation / setTranslations 与状态统计', () => {
    store.upsert('g1', [
      e('p1', 'name', '一'),
      e('p2', 'name', '二'),
      e('p3', 'name', '三'),
    ]);
    expect(store.setTranslation('g1', 'p1', 'name', '壹')).toBe(true);
    expect(store.setTranslation('g1', 'nope', 'name', 'x')).toBe(false);

    const n = store.setTranslations('g1', [
      { path: 'p2', key: 'name', translated: '贰' },
      { path: 'p3', key: 'name', translated: '叁', status: 'reviewed' },
      { path: 'p9', key: 'name', translated: '不存在' },
    ]);
    expect(n).toBe(2);

    const st = store.stats('g1');
    expect(st.total).toBe(3);
    expect(st.byStatus.translated).toBe(2);
    expect(st.byStatus.reviewed).toBe(1);
    expect(st.byStatus.pending).toBe(0);
  });

  it('list 支持按状态/引擎过滤与分页', () => {
    store.upsert('g1', [e('p1', 'k', 'a'), e('p2', 'k', 'b'), e('p3', 'k', 'c')]);
    store.setTranslation('g1', 'p2', 'k', 'B');
    expect(store.list('g1', { status: 'translated' }).map((x) => x.path)).toEqual(['p2']);
    expect(store.list('g1', { status: 'pending' })).toHaveLength(2);
    expect(store.list('g1', { limit: 2 })).toHaveLength(2);
    expect(store.list('g1', { limit: 2, offset: 2 })).toHaveLength(1);
    expect(store.list('g1', { engine: 'renpy' })).toHaveLength(0);
  });

  it('FTS5 trigram：中日文可搜子串（≥3 字符）', () => {
    store.upsert('g1', [
      e('p1', 'cmd401', '这是一个测试文本，用来验证中文检索'),
      e('p2', 'cmd401', 'こんにちは世界、これはテストです'),
      e('p3', 'cmd401', '无关内容 entirely unrelated'),
    ]);
    expect(store.search('g1', '测试文').map((x) => x.path)).toEqual(['p1']);
    expect(store.search('g1', 'にちは世').map((x) => x.path)).toEqual(['p2']);
    expect(store.search('g1', 'unrelated').map((x) => x.path)).toEqual(['p3']);
    // 搜中间片段（unicode61 做不到的）
    expect(store.search('g1', '验证中文').map((x) => x.path)).toEqual(['p1']);
  });

  it('短查询（<3 字符）自动退回 LIKE', () => {
    store.upsert('g1', [e('p1', 'k', '你好世界'), e('p2', 'k', '再见世界')]);
    expect(store.search('g1', '世界').map((x) => x.path).sort()).toEqual(['p1', 'p2']);
    expect(store.search('g1', '你好').map((x) => x.path)).toEqual(['p1']);
    expect(store.search('g1', '   ')).toEqual([]);
  });

  it('FTS 触发器同步：改译文后能搜到新译文、搜不到旧译文', () => {
    store.upsert('g1', [e('p1', 'k', 'original text')]);
    expect(store.search('g1', 'translated text')).toHaveLength(0);

    store.setTranslation('g1', 'p1', 'k', 'changed translation');
    expect(store.search('g1', 'changed translation').map((x) => x.path)).toEqual(['p1']);
    expect(store.search('g1', 'original text')).toHaveLength(1); // 原文仍在 FTS 里
  });

  it('extra 以 JSON 往返', () => {
    store.upsert('g1', [e('p1', 'k', 'x', { controlCodes: ['\\N[1]'], line: 12 })]);
    expect(store.getEntry('g1', 'p1', 'k')?.extra).toEqual({ controlCodes: ['\\N[1]'], line: 12 });
  });

  it('不同游戏的数据互相隔离', () => {
    store.upsert('g1', [e('p1', 'k', '游戏一')]);
    store.upsert('g2', [e('p1', 'k', '游戏二')]);
    expect(store.stats('g1').total).toBe(1);
    expect(store.stats('g2').total).toBe(1);
    expect(store.getEntry('g1', 'p1', 'k')?.source).toBe('游戏一');
    expect(store.getEntry('g2', 'p1', 'k')?.source).toBe('游戏二');
  });

  it('删除游戏级联清空条目', () => {
    store.upsert('g1', [e('p1', 'k', 'a'), e('p2', 'k', 'b')]);
    expect(store.removeGame('g1')).toBe(1);
    expect(store.stats('g1').total).toBe(0);
  });

  it('游戏元数据可读写', () => {
    store.ensureGame('g1', { title: '测试游戏', dir: 'D:/games/x', engineId: 'mvmz' });
    const g = store.getGame('g1');
    expect(g?.title).toBe('测试游戏');
    expect(g?.engineId).toBe('mvmz');
    expect(g?.translationScope).toBe('ja>zh-CN');

    store.ensureGame('g1', { translationScope: 'ja>en' });
    expect(store.getGame('g1')?.translationScope).toBe('ja>en');
  });

  it('可修复列已创建但版本号未更新的半迁移数据库', () => {
    const root = mkdtempSync(join(tmpdir(), 'baibao-schema-'));
    const path = join(root, 'half-migrated.db');
    const db = new Database(path);
    db.exec(`
      CREATE TABLE game (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        dir TEXT NOT NULL,
        engine_id TEXT,
        engine_version TEXT,
        added_at INTEGER NOT NULL,
        translation_scope TEXT NOT NULL DEFAULT 'ja>zh-CN'
      );
      PRAGMA user_version = 1;
    `);
    db.close();

    const migrated = new TextStore(path);
    migrated.ensureGame('g1', { translationScope: 'ja>en' });
    expect(migrated.getGame('g1')?.translationScope).toBe('ja>en');
    migrated.close();

    const verified = new Database(path, { readonly: true });
    expect(verified.pragma('user_version', { simple: true })).toBe(2);
    verified.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('hashSource 稳定且区分大小写内容', () => {
    expect(hashSource('abc')).toBe(hashSource('abc'));
    expect(hashSource('abc')).not.toBe(hashSource('abd'));
  });

  it('probe 自检：SQLite 版本 / FTS 可用 / trigram 分词器', () => {
    const p = store.probe();
    expect(p.sqliteVersion).toMatch(/^\d+\.\d+/);
    expect(p.ftsMatchOk).toBe(true);
    expect(p.trigramOk).toBe(true);
  });
});
