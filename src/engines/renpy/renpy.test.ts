import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renpyAdapter } from './index';
import type { TextEntry } from '@shared/contracts';

/**
 * Ren'Py 适配器完整集成测试（fs 落盘）：detect → extract → repack → 校验 + 备份。
 */

const SCRIPT = `define e = Character("Eileen")
# 注释

label start:
    scene bg room
    play music "bgm/title.ogg"

    "It's a new day."
    e "Hello, [player_name]!"
    "He said \\"hi\\" to me."

    menu:
        "出门":
            jump outside
        "留下":
            pass
`;

describe("renpy 适配器集成", () => {
  let gameDir: string;
  let gameSub: string;

  beforeAll(async () => {
    gameDir = await fs.mkdtemp(join(tmpdir(), 'baibao-renpy-'));
    gameSub = join(gameDir, 'game');
    await fs.mkdir(gameSub, { recursive: true });
    await fs.writeFile(join(gameSub, 'script.rpy'), SCRIPT, 'utf8');
    // tl/ 目录应被跳过（官方翻译目录，不是原文）
    await fs.mkdir(join(gameSub, 'tl', 'chinese'), { recursive: true });
    await fs.writeFile(join(gameSub, 'tl', 'chinese', 'script.rpy'), '"这条不该被抽"', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(gameDir, { recursive: true, force: true });
  });

  it('detect 命中并报告脚本目录', async () => {
    const d = await renpyAdapter.detect(gameDir);
    expect(d.matched).toBe(true);
    expect(d.engineId).toBe('renpy');
    expect(d.confidence).toBeGreaterThan(0.5);
  });

  it('extract 抽到对白/旁白/选项/显示名，且跳过 tl 与资源', async () => {
    const entries: TextEntry[] = [];
    for await (const e of renpyAdapter.extract(gameDir)) entries.push(e);
    const src = entries.map((e) => e.source);

    expect(src).toContain('Eileen');
    expect(src).toContain("It's a new day.");
    expect(src).toContain('Hello, [player_name]!');
    expect(src).toContain('He said \\"hi\\" to me.');
    expect(src).toContain('出门');
    expect(src).toContain('留下');
    // 资源名 / tl 目录 / 注释 不抽
    expect(src).not.toContain('bgm/title.ogg');
    expect(src).not.toContain('这条不该被抽');
    expect(src.some((s) => s.includes('注释'))).toBe(false);
    // 路径可回写
    for (const e of entries) expect(e.path).toMatch(/#\/L\d+\/\d+$/);
  });

  it('repack 回写译文、保留控制符与转义、生成备份', async () => {
    const entries: TextEntry[] = [];
    for await (const e of renpyAdapter.extract(gameDir)) {
      entries.push({ ...e, translated: `【译】${e.source}`, status: 'translated' });
    }
    const res = await renpyAdapter.repack(gameDir, entries);
    expect(res.errors).toEqual([]);
    expect(res.written).toBe(entries.length);
    expect(res.backupDir).not.toBe('');

    const backups = await fs.readdir(res.backupDir);
    expect(backups.length).toBeGreaterThan(0);

    const out = await fs.readFile(join(gameSub, 'script.rpy'), 'utf8');
    expect(out).toContain('【译】Hello, [player_name]!'); // 控制符未丢
    expect(out).toContain('He said \\"hi\\" to me.'); // 转义未坏
    expect(out).toContain('【译】出门');
    expect(out).toContain('play music "bgm/title.ogg"'); // 资源行原样
    expect(out).toContain('# 注释'); // 注释行原样
  });
});
