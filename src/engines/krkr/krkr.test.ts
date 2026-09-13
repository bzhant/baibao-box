import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { krkrAdapter } from './index';
import {
  decodeKs,
  encodeKs,
  detectEncoding,
  splitLine,
  isTranslatable,
  extractKsText,
  replaceKsSegment,
} from './ks-parse';
import type { TextEntry } from '@shared/contracts';

/** 尽量贴近真实 .ks 的语料：注释 / 标签 / 命令 / 带内联标签的对白 / CRLF / BOM */
const KS_TEXT = [
  ';シナリオ 第一章',
  '*start',
  '@bg storage="room" time=1000',
  '@playbgm storage="theme"',
  'おはよう、[emb exp="f.name"]。[r]',
  '今日はいい天気だね。[l][r]',
  '———',
  '[r]',
  '*end',
  '@return',
].join('\r\n');

async function writeKs(dir: string, rel: string, body: string, bom = true): Promise<string> {
  const full = join(dir, rel);
  await fs.mkdir(join(full, '..'), { recursive: true });
  const buf = await encodeKs(body, bom ? 'utf-8-bom' : 'utf-8');
  await fs.writeFile(full, buf.buf);
  return full;
}

describe('ks 解析：切分与抽取', () => {
  it('注释 / 标签行 / 命令整行保留，普通行按 [] 切成文本段与标签', () => {
    expect(splitLine(';コメント')[0].type).toBe('comment');
    expect(splitLine('*start')[0].type).toBe('label');
    expect(splitLine('@bg storage="room"')[0].type).toBe('command');

    const segs = splitLine('おはよう、[emb exp="f.name"]。[r]');
    expect(segs.map((s) => s.type)).toEqual(['text', 'tag', 'text', 'tag']);
    expect(segs[0].value).toBe('おはよう、');
    expect(segs[1].value).toBe('[emb exp="f.name"]');
    expect(segs[2].value).toBe('。');
    expect(segs[3].value).toBe('[r]');
  });

  it('纯符号不翻，含文字才翻', () => {
    expect(isTranslatable('おはよう')).toBe(true);
    expect(isTranslatable('。')).toBe(false); // 只有标点
    expect(isTranslatable('———')).toBe(false);
    expect(isTranslatable('   ')).toBe(false);
  });

  it('抽取带行号与段号，跳过不可译段与整行标签', () => {
    const slots = extractKsText(KS_TEXT);
    const asList = slots.map((s) => `L${s.line}:${s.ordinal} ${s.source}`);
    expect(asList).toContain('L5:0 おはよう、');
    expect(asList).toContain('L6:0 今日はいい天気だね。');
    // '。'（L5:1）、'———'（L7）、'[r]'（L8）都该被跳过
    expect(slots.every((s) => s.source !== '。')).toBe(true);
    expect(slots.every((s) => !s.source.includes('———'))).toBe(true);
    // 命令里的 storage="room" 绝不能被抽出来
    expect(slots.every((s) => !s.source.includes('storage'))).toBe(true);
  });

  it('替换指定段，其余字节不动', () => {
    const line = 'おはよう、[emb exp="f.name"]。[r]';
    expect(replaceKsSegment(line, 0, '早上好、')).toBe('早上好、[emb exp="f.name"]。[r]');
    expect(replaceKsSegment(line, 1, '！')).toBe('おはよう、[emb exp="f.name"]！[r]');
    expect(replaceKsSegment(line, 5, 'x')).toBeNull(); // 定位失败
  });

  it('CRLF 不会被吞', () => {
    const withCr = 'あいう[r]\r';
    expect(replaceKsSegment(withCr, 0, '一二三')).toBe('一二三[r]\r');
  });
});

describe('编码', () => {
  it('识别 UTF-8 BOM / 无 BOM / UTF-16LE', async () => {
    expect(detectEncoding((await encodeKs('abc', 'utf-8-bom')).buf)).toBe('utf-8-bom');
    expect(detectEncoding((await encodeKs('abc', 'utf-8')).buf)).toBe('utf-8');
    expect(detectEncoding((await encodeKs('abc', 'utf-16le')).buf)).toBe('utf-16le');
  });

  it('★ Shift-JIS 装不下简体中文时如实报告 lossy（否则会静默变 ?）', async () => {
    const jp = await encodeKs('こんにちは', 'shift_jis');
    expect(jp.lossy).toBe(false); // 日文没问题

    const zh = await encodeKs('测试中文', 'shift_jis');
    expect(zh.lossy).toBe(true); // 简体字在 Shift-JIS 里没有
  });

  it('Shift-JIS 文件能被正确解码读出', () => {
    // 'こんにちは' 的 Shift-JIS 字节
    const buf = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
    const { text, encoding } = decodeKs(buf);
    expect(encoding).toBe('shift_jis');
    expect(text).toBe('こんにちは');
  });
});

describe('KiriKiri 适配器', () => {
  let root: string;
  let game: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-krkr-'));
    game = join(root, 'game');
    await fs.mkdir(join(game, 'data', 'scenario'), { recursive: true });
    await writeKs(game, 'data/scenario/first.ks', KS_TEXT);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('detect 命中并报告脚本数量', async () => {
    const d = await krkrAdapter.detect(game);
    expect(d.matched).toBe(true);
    expect(d.engineId).toBe('krkr');
    expect(d.confidence).toBeGreaterThan(0.5);
    expect(d.notes?.join(' ')).toContain('1 个 .ks');
  });

  it('.scn（编译脚本）会被明确提示不支持', async () => {
    await fs.writeFile(join(game, 'data/scenario/second.scn'), Buffer.from([0x00, 0x01, 0x02]));
    const d = await krkrAdapter.detect(game);
    expect(d.notes?.join(' ')).toContain('.scn');
    expect(d.notes?.join(' ')).toContain('暂不支持');
  });

  it('抽取 -> 回写：译文到位、内联标签与无关行原样保留', async () => {
    const entries: TextEntry[] = [];
    for await (const e of krkrAdapter.extract(game)) entries.push(e);
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.path)).toEqual([
      'data/scenario/first.ks#L5:0',
      'data/scenario/first.ks#L6:0',
    ]);

    const done = entries.map((e, i) => ({
      ...e,
      translated: i === 0 ? '早上好、' : '今天天气真好。',
      status: 'translated' as const,
    }));
    const res = await krkrAdapter.repack(game, done);
    expect(res.errors).toEqual([]);
    expect(res.written).toBe(2);
    expect(res.backupDir).not.toBe('');

    const after = decodeKs(await fs.readFile(join(game, 'data/scenario/first.ks')));
    expect(after.text).toContain('早上好、[emb exp="f.name"]。[r]');
    expect(after.text).toContain('今天天气真好。[l][r]');
    // 命令/注释/标签行一字未动
    expect(after.text).toContain('@bg storage="room" time=1000');
    expect(after.text).toContain('*start');
    expect(after.text).toContain(';シナリオ 第一章');
    // CRLF 保留
    expect(after.text).toContain('\r\n');
    // BOM 保留
    expect(after.encoding).toBe('utf-8-bom');
  });

  it('回写幂等：第二次 written=0 且不重复建备份', async () => {
    const entries: TextEntry[] = [];
    for await (const e of krkrAdapter.extract(game)) entries.push(e);
    const done = entries.map((e) => ({ ...e, translated: '译', status: 'translated' as const }));

    const r1 = await krkrAdapter.repack(game, done);
    expect(r1.written).toBe(2);
    const r2 = await krkrAdapter.repack(game, done);
    expect(r2.written).toBe(0);
    expect(r2.unchanged).toBe(2);
    expect(r2.backupDir).toBe('');
  });

  it('安全阀：pending / conflict 不写回', async () => {
    const entries: TextEntry[] = [];
    for await (const e of krkrAdapter.extract(game)) entries.push(e);
    const risky = entries.map((e) => ({
      ...e,
      translated: '译文',
      status: 'conflict' as const,
    }));
    const res = await krkrAdapter.repack(game, risky);
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(entries.length);

    const after = decodeKs(await fs.readFile(join(game, 'data/scenario/first.ks')));
    expect(after.text).toBe(KS_TEXT);
  });

  it('★ Shift-JIS 游戏翻成中文：自动降级 UTF-8 with BOM 并给出提示', async () => {
    const iconv = (await import('iconv-lite')) as unknown as {
      encode: (s: string, e: string) => Buffer;
    };
    const sjis = iconv.encode(
      [';コメント', '*start', 'こんにちは。[r]', 'さようなら。[r]'].join('\r\n'),
      'shift_jis',
    );
    const rel = 'data/scenario/sjis.ks';
    await fs.writeFile(join(game, rel), sjis);

    const entries: TextEntry[] = [];
    for await (const e of krkrAdapter.extract(game)) {
      if (e.path.startsWith('data/scenario/sjis.ks')) entries.push(e);
    }
    expect(entries.length).toBe(2);
    expect(entries[0].source).toBe('こんにちは。');

    const done = entries.map((e, i) => ({
      ...e,
      translated: i === 0 ? '你好。' : '再见。',
      status: 'translated' as const,
    }));
    const res = await krkrAdapter.repack(game, done);

    expect(res.written).toBe(2);
    expect(res.notes?.join(' ')).toContain('UTF-8 with BOM');

    // 降级后文件是 UTF-8 BOM，中文没有变成问号
    const after = decodeKs(await fs.readFile(join(game, rel)));
    expect(after.encoding).toBe('utf-8-bom');
    expect(after.text).toContain('你好。');
    expect(after.text).not.toContain('?');
  });
});
