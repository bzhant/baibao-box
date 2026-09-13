import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './translate-pipeline';
import { TextStore } from '@platform/store/text-store';
import { mvmzAdapter } from '../engines/mvmz';
import type { TranslationProvider, TextEntry } from '@shared/contracts';

/**
 * **真实游戏**端到端验证：把本机真实 MV/MZ 游戏的相关文件复制到临时目录，
 * 跑完整流水线（抽取 → 翻译 → 回写 → 字体），断言闭环成立、控制符完好、
 * 且**第二次运行不会重复翻译**。全程不触碰原游戏。
 * 样本不在本机时自动跳过。
 */

/** 保留占位符的假机翻（不调真实 API，避免花钱/依赖密钥） */
const stub: TranslationProvider = {
  id: 'stub',
  displayName: '本地假机翻',
  async translate(reqs) {
    return reqs.map((r) => ({ id: r.id, translated: `【中】${r.source}`, provider: 'stub' }));
  },
};

/** MV 样本（原始日文游戏，字体未被改过） */
const MV_SRC = process.env.BB_MV_SAMPLE ?? '__no_sample__';
/** MZ 样本（根布局） */
const MZ_SRC = process.env.BB_MZ_SAMPLE ?? '__no_sample__';

const DB_FILES = [
  'System.json', 'Actors.json', 'Classes.json', 'Items.json', 'Skills.json',
  'States.json', 'Weapons.json', 'Armors.json', 'Enemies.json', 'MapInfos.json',
  'CommonEvents.json', 'Troops.json',
];

/** 从真实游戏里挑一部分文件复制成可测样本（控制体积，但内容是真的） */
async function copySample(src: string, dst: string, maxMaps = 3): Promise<number> {
  const www = existsSync(join(src, 'www')) ? join(src, 'www') : src;
  await fs.mkdir(join(dst, 'data'), { recursive: true });
  await fs.mkdir(join(dst, 'js'), { recursive: true });
  let n = 0;
  for (const f of DB_FILES) {
    try {
      await fs.copyFile(join(www, 'data', f), join(dst, 'data', f));
      n++;
    } catch { /* 缺失跳过 */ }
  }
  let maps = 0;
  try {
    for (const f of (await fs.readdir(join(www, 'data'))).filter((x) => /^Map\d+\.json$/.test(x))) {
      if (maps >= maxMaps) break;
      await fs.copyFile(join(www, 'data', f), join(dst, 'data', f));
      maps++;
    }
  } catch { /* ignore */ }
  // 引擎核心 js（用于 MV/MZ 判定）
  for (const f of ['rmmz_core.js', 'rpg_core.js']) {
    try {
      await fs.copyFile(join(www, 'js', f), join(dst, 'js', f));
    } catch { /* ignore */ }
  }
  // 字体相关（用于 MV 的 CSS 加固）
  try {
    await fs.mkdir(join(dst, 'fonts'), { recursive: true });
    await fs.copyFile(join(www, 'fonts', 'gamefont.css'), join(dst, 'fonts', 'gamefont.css'));
  } catch { /* ignore */ }
  return n;
}

function runRealSuite(name: string, src: string) {
  const srcOk = existsSync(join(src, 'data')) || existsSync(join(src, 'www', 'data'));
  describe.skipIf(!srcOk)(`真实游戏闭环：${name}`, () => {
    let root: string;
    let game: string;
    let store: TextStore;

    beforeEach(async () => {
      root = await fs.mkdtemp(join(tmpdir(), 'baibao-realpipe-'));
      game = join(root, 'game');
      await copySample(src, game);
      store = new TextStore(join(root, 'db.sqlite'));
    });
    afterEach(async () => {
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    });

    const base = () => ({
      gameDir: game,
      gameId: 'real',
      adapter: mvmzAdapter,
      store,
      from: 'ja',
      to: 'zh-CN',
      batchSize: 50,
    });

    it('完整闭环：抽取 → 翻译 → 回写 → 字体，控制符零损失', async () => {
      // 先记录原始文本里带控制符的条目（用于事后比对）
      const before: TextEntry[] = [];
      for await (const e of mvmzAdapter.extract(game)) before.push(e);
      const withCodes = before.filter((e) => /\\(?:[A-Za-z]\[[^\]]*\]|[{}$.|!<>^])/.test(e.source));

      expect(before.length).toBeGreaterThan(100); // 真实游戏文本量

      const rep = await runPipeline({ ...base(), provider: stub, injectFont: true });

      console.log(
        `[real ${name}] 抽取 ${rep.extracted} 条 · 带控制符 ${withCodes.length} 条 · 翻译 ${rep.translated} · ` +
          `回写 ${rep.repack?.written} · 冲突 ${rep.conflicts} · 失败 ${rep.failed} · ${rep.durationMs}ms · ` +
          `字体=${rep.font?.applied ? '已注入' : '无变化'}`,
      );

      expect(rep.errors).toEqual([]);
      expect(rep.extracted).toBe(before.length);
      expect(rep.alreadyApplied).toBe(0);
      expect(rep.translated).toBeGreaterThan(100);
      expect(rep.conflicts).toBe(0);
      expect(rep.failed).toBe(0);
      expect(rep.repack?.written).toBe(rep.translated);
      expect(rep.repack?.errors).toEqual([]);
      expect(rep.font?.applied).toBe(true);

      // 中文库状态
      const st = store.stats('real');
      expect(st.byStatus.translated).toBe(rep.translated);
      expect(st.byStatus.pending).toBe(0);

      // 字体：MV → locale=zh_CN；MZ → fallbackFonts 含中文栈
      const wwwDir = existsSync(join(game, 'www')) ? join(game, 'www') : game;
      const sys = JSON.parse(await fs.readFile(join(wwwDir, 'data', 'System.json'), 'utf8'));
      const fontOk = sys.locale === 'zh_CN' || String(sys.advanced?.fallbackFonts ?? '').includes('Microsoft YaHei');
      expect(fontOk).toBe(true);

      // 控制符零损失：把回写后的游戏再抽一遍，凡是我们写过的译文，控制符必须还在
      const after: TextEntry[] = [];
      for await (const e of mvmzAdapter.extract(game)) after.push(e);
      const translatedNow = after.filter((e) => e.source.startsWith('【中】'));
      expect(translatedNow.length).toBe(rep.translated);

      // 逐条核对：写回后的文本 = 【中】 + 原文本（控制符逐字保留）
      const origByPath = new Map(before.map((e) => [`${e.path}\u0000${e.key}`, e.source]));
      let mismatched = 0;
      for (const e of translatedNow) {
        const orig = origByPath.get(`${e.path}\u0000${e.key}`);
        if (orig && e.source !== `【中】${orig}`) mismatched++;
      }
      expect(mismatched).toBe(0);
      expect(withCodes.length).toBeGreaterThan(0); // 真实样本里确实有控制符
    });

    it('★ 再跑一次：绝不重复翻译（否则会变成【中】【中】…毁掉游戏）', async () => {
      const first = await runPipeline({ ...base(), provider: stub });
      expect(first.translated).toBeGreaterThan(100);

      const second = await runPipeline({ ...base(), provider: stub });
      expect(second.extracted).toBe(first.extracted);
      expect(second.alreadyApplied).toBe(first.extracted); // 全部识别为"我们写回的"
      expect(second.translated).toBe(0);
      expect(second.repack?.written).toBe(0);

      // 没有任何条目被翻第二遍
      const after: TextEntry[] = [];
      for await (const e of mvmzAdapter.extract(game)) after.push(e);
      expect(after.some((e) => e.source.includes('【中】【中】'))).toBe(false);
    });

    it('重复运行幂等：库不膨胀、状态不乱', async () => {
      await runPipeline({ ...base(), provider: stub });
      const s1 = store.stats('real');
      await runPipeline({ ...base(), provider: stub });
      const s2 = store.stats('real');
      expect(s2.total).toBe(s1.total);
      expect(s2.byStatus.translated).toBe(s1.byStatus.translated);
    });
  });
}

runRealSuite('RPG Maker MV', MV_SRC);
runRealSuite('RPG Maker MZ（Going to the caves NTR）', MZ_SRC);
