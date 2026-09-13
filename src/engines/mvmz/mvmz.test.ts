import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mvmzAdapter, looksEncryptedData, extractSystemText } from './index';
import type { TextEntry } from '@shared/contracts';

/**
 * MV/MZ 适配器完整集成测试（fs 落盘）：detect → extract → repack → 校验 + 备份。
 * 在真实环境用 `npm test` 跑（vitest 能解析扩展名省略的相对导入）。
 */

const FIXTURE = {
  'System.json': {},
  'Actors.json': [null, { id: 1, name: 'アーサー', nickname: '勇者', profile: '伝説の剣士。' }],
  'Items.json': [null, { id: 1, name: 'ポーション', description: 'HPを50回復。' }],
  'CommonEvents.json': [null, {
    id: 1, name: '挨拶', list: [
      { code: 101, indent: 0, parameters: ['', 0, 0, 2] },
      { code: 401, indent: 0, parameters: ['こんにちは、\\N[1]！'] },
      { code: 102, indent: 0, parameters: [['はい', 'いいえ'], 0, 0, 2, 0] },
    ],
  }],
  'Map001.json': {
    displayName: '始まりの村',
    events: [null, {
      id: 1, name: '村人', pages: [
        { list: [
          { code: 401, indent: 0, parameters: ['ようこそ、\\C[2]旅人\\C[0]。'] },
          { code: 250, indent: 0, parameters: [{ name: 'Bell', volume: 90, pitch: 100 }] },
        ] },
      ],
    }],
  },
};

describe('mvmz 适配器集成', () => {
  let gameDir: string;
  let dataDir: string;

  beforeAll(async () => {
    gameDir = await fs.mkdtemp(join(tmpdir(), 'baibao-mvmz-'));
    dataDir = join(gameDir, 'data');
    await fs.mkdir(dataDir, { recursive: true });
    for (const [file, json] of Object.entries(FIXTURE)) {
      await fs.writeFile(join(dataDir, file), JSON.stringify(json), 'utf8');
    }
  });

  afterAll(async () => {
    await fs.rm(gameDir, { recursive: true, force: true });
  });

  it('detect 命中且指向数据目录', async () => {
    const d = await mvmzAdapter.detect(gameDir);
    expect(d.matched).toBe(true);
    expect(d.engineId).toBe('mvmz');
    expect(d.confidence).toBeGreaterThan(0.5);
  });

  it('extract 抽到 数据库字段 + 事件对白', async () => {
    const entries: TextEntry[] = [];
    for await (const e of mvmzAdapter.extract(gameDir)) entries.push(e);

    const sources = entries.map((e) => e.source);
    // 数据库字段
    expect(sources).toContain('アーサー');
    expect(sources).toContain('伝説の剣士。');
    expect(sources).toContain('ポーション');
    // 事件对白（控制符保留）
    expect(sources).toContain('こんにちは、\\N[1]！');
    expect(sources).toContain('はい');
    expect(sources).toContain('いいえ');
    expect(sources).toContain('ようこそ、\\C[2]旅人\\C[0]。');
    // 音效资源名不应被抽
    expect(sources).not.toContain('Bell');
    // 每条都有可回写的 pointer 路径
    for (const e of entries) expect(e.path).toMatch(/#\//);
  });

  it('repack 回写译文、保留控制符、生成备份', async () => {
    const entries: TextEntry[] = [];
    for await (const e of mvmzAdapter.extract(gameDir)) {
      entries.push({ ...e, translated: `【译】${e.source}`, status: 'translated' });
    }
    const res = await mvmzAdapter.repack(gameDir, entries);
    expect(res.errors).toEqual([]);
    expect(res.written).toBe(entries.length);
    expect(res.backupDir).not.toBe('');

    // 备份文件确实生成
    const backups = await fs.readdir(res.backupDir);
    expect(backups.length).toBeGreaterThan(0);

    // 回写后文件仍合法、译文到位、控制符未丢
    const ce = JSON.parse(await fs.readFile(join(dataDir, 'CommonEvents.json'), 'utf8'));
    expect(ce[1].list[1].parameters[0]).toBe('【译】こんにちは、\\N[1]！');
    expect(ce[1].list[2].parameters[0][0]).toBe('【译】はい');

    const map = JSON.parse(await fs.readFile(join(dataDir, 'Map001.json'), 'utf8'));
    expect(map.events[1].pages[0].list[0].parameters[0]).toBe('【译】ようこそ、\\C[2]旅人\\C[0]。');
    // 音效指令未被破坏
    expect(map.events[1].pages[0].list[1].parameters[0].name).toBe('Bell');
  });

  it('★ 安全阀：pending / conflict 条目一律不回写', async () => {
    const entries: TextEntry[] = [];
    for await (const e of mvmzAdapter.extract(gameDir)) entries.push(e);
    expect(entries.length).toBeGreaterThan(0);

    // 注意：本夹具被同组前面的测试改过，所以这里比对"本次调用前后是否一致"，
    // 而不是比对原始内容。
    const before = new Map<string, string>();
    for (const f of ['Actors.json', 'CommonEvents.json', 'Items.json']) {
      before.set(f, await fs.readFile(join(dataDir, f), 'utf8'));
    }

    const risky = entries.map((e, i) => ({
      ...e,
      translated: `【译】${e.source}`,
      status: (i % 2 === 0 ? 'pending' : 'conflict') as TextEntry['status'],
    }));
    const res = await mvmzAdapter.repack(gameDir, risky);
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(risky.length);

    for (const [f, content] of before) {
      expect(await fs.readFile(join(dataDir, f), 'utf8')).toBe(content);
    }
  });
});

describe('System.json 词条抽取', () => {
  it('抽菜单可见字段，跳过空串与资源名', () => {
    const sys = {
      gameTitle: 'タイトル',
      currencyUnit: 'Ｇ',
      elements: ['', '炎', '氷'], // 索引 0 是空占位，应跳过
      skillTypes: ['', '神聖'],
      sounds: [{ name: 'cursor_se', pan: 0 }], // 音效资源名，绝不能抽
      battleback1Name: 'Grassland', // 资源路径，绝不能抽
      locale: 'ja_JP',
      terms: {
        basic: ['レベル', 'HP'],
        commands: ['戦う', '逃げる'],
        messages: { actionFailure: '%1は失敗した！', levelUp: '%1はレベル%2に上がった！' },
      },
    };
    const slots = extractSystemText(sys);
    const src = slots.map((s) => s.source);

    expect(src).toContain('タイトル');
    expect(src).toContain('Ｇ');
    expect(src).toContain('炎');
    expect(src).toContain('神聖');
    expect(src).toContain('レベル');
    expect(src).toContain('戦う');
    expect(src).toContain('%1はレベル%2に上がった！');
    expect(src).not.toContain(''); // 空串不算
    expect(src).not.toContain('cursor_se'); // 资源名不抽
    expect(src).not.toContain('Grassland'); // 资源路径不抽
    expect(src).not.toContain('ja_JP'); // locale 不抽（它是我们的控制位）

    // 指针可定位回原位置
    const title = slots.find((s) => s.source === 'タイトル')!;
    expect(title.pointer).toEqual(['gameTitle']);
    const lvUp = slots.find((s) => s.source.startsWith('%1はレベル'))!;
    expect(lvUp.pointer).toEqual(['terms', 'messages', 'levelUp']);
    const ice = slots.find((s) => s.source === '氷')!;
    expect(ice.pointer).toEqual(['elements', '2']);
  });
});

/** 实测发现：部分 MV/MZ 游戏把 data/*.json 用 CryptoJS AES 加密（游戏自身防篡改）。 */
describe('加密数据文件检测', () => {
  it('looksEncryptedData 识别 CryptoJS 密文前缀', () => {
    expect(looksEncryptedData('U2FsdGVkX1+3q8dA/nv3DYK0GkzprdQi')).toBe(true);
    expect(looksEncryptedData('{"gameTitle":"x"}')).toBe(false);
    expect(looksEncryptedData('')).toBe(false);
  });

  it('全加密的游戏：detect 命中但报告不可静态抽取', async () => {
    const g = await fs.mkdtemp(join(tmpdir(), 'baibao-enc-'));
    const data = join(g, 'data');
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(join(data, 'System.json'), 'U2FsdGVkX1+3q8dA/nv3DYK0GkzprdQi0FAKE', 'utf8');
    await fs.writeFile(join(data, 'Map001.json'), 'U2FsdGVkX1+AAAABBBBCCCCDDDDEEEE', 'utf8');
    try {
      const d = await mvmzAdapter.detect(g);
      expect(d.matched).toBe(true);
      expect(d.confidence).toBeLessThan(0.9);
      expect(d.notes?.join(' ')).toContain('已加密');
      expect(d.notes?.join(' ')).toContain('静态抽取不可用');

      // 抽取不应抛错，也不应产出条目
      const entries: TextEntry[] = [];
      for await (const e of mvmzAdapter.extract(g)) entries.push(e);
      expect(entries).toHaveLength(0);
    } finally {
      await fs.rm(g, { recursive: true, force: true });
    }
  });

  it('混合（部分可读部分加密）：置信度仍高但给出提示', async () => {
    const g = await fs.mkdtemp(join(tmpdir(), 'baibao-mix-'));
    const data = join(g, 'data');
    await fs.mkdir(data, { recursive: true });
    await fs.writeFile(join(data, 'System.json'), '{}', 'utf8');
    await fs.writeFile(join(data, 'Actors.json'), JSON.stringify([null, { id: 1, name: 'アーサー' }]), 'utf8');
    await fs.writeFile(join(data, 'Items.json'), 'U2FsdGVkX1+ZZZZYYYYXXXX', 'utf8');
    try {
      const d = await mvmzAdapter.detect(g);
      expect(d.confidence).toBe(0.9);
      expect(d.notes?.join(' ')).toContain('1 个 .json 已加密被跳过');
      const entries: TextEntry[] = [];
      for await (const e of mvmzAdapter.extract(g)) entries.push(e);
      expect(entries.map((x) => x.source)).toContain('アーサー'); // 可读的照常抽
    } finally {
      await fs.rm(g, { recursive: true, force: true });
    }
  });

  it('本机真实加密游戏能被识别出来', async () => {
    const g = process.env.BB_ENCRYPTED_SAMPLE ?? '__no_sample__';
    if (!existsSync(join(g, 'js', 'rmmz_core.js'))) return; // 样本不在则跳过
    const d = await mvmzAdapter.detect(g);
    expect(d.matched).toBe(true);
    expect(d.notes?.join(' ')).toContain('已加密');
  });
});
