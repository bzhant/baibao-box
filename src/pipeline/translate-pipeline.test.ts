import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPipeline } from './translate-pipeline';
import { TextStore } from '@platform/store/text-store';
import { mvmzAdapter } from '../engines/mvmz';
import type { TranslationProvider } from '@shared/contracts';

/** 保留占位符的"假机翻"（正常路径） */
const goodProvider: TranslationProvider = {
  id: 'stub-good',
  displayName: '保留占位符的假机翻',
  async translate(reqs) {
    return reqs.map((r) => ({ id: r.id, translated: `【译】${r.source}`, provider: 'stub-good' }));
  },
};

/** 会把 `__BBn__` 占位符整个删掉的"假机翻"（模拟真实 MT 破坏控制符） */
const badProvider: TranslationProvider = {
  id: 'stub-bad',
  displayName: '会破坏占位符的假机翻',
  async translate(reqs) {
    return reqs.map((r) => ({
      id: r.id,
      translated: `【译】${r.source.replace(/__BB\d+__/g, '')}`,
      provider: 'stub-bad',
    }));
  },
};

const DIALOGUE = 'こんにちは、\\N[1]！'; // 含 RPG Maker 控制符 \N[1]

describe('汉化流水线（闭环）', () => {
  let root: string;
  let game: string;
  let dbFile: string;
  let store: TextStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-pipe-'));
    game = join(root, 'game');
    await fs.mkdir(join(game, 'www', 'js'), { recursive: true });
    await fs.mkdir(join(game, 'www', 'data'), { recursive: true });
    await fs.mkdir(join(game, 'www', 'fonts'), { recursive: true });

    await fs.writeFile(join(game, 'www', 'js', 'rpg_core.js'), '// mv');
    await fs.writeFile(
      join(game, 'www', 'fonts', 'gamefont.css'),
      '@font-face {\n  font-family: GameFont;\n  src: url("mplus-1m-regular.ttf");\n}\n',
    );
    await fs.writeFile(
      join(game, 'www', 'data', 'System.json'),
      JSON.stringify({
        gameTitle: 'テストゲーム',
        locale: 'ja_JP',
        terms: { basic: ['レベル', 'HP'], messages: { actionFailure: '%1は失敗した！' } },
      }),
    );
    await fs.writeFile(
      join(game, 'www', 'data', 'Actors.json'),
      JSON.stringify([null, { id: 1, name: 'アーサー' }]),
    );
    await fs.writeFile(
      join(game, 'www', 'data', 'CommonEvents.json'),
      JSON.stringify([
        null,
        { id: 1, name: '挨拶', list: [{ code: 401, indent: 0, parameters: [DIALOGUE] }] },
      ]),
    );

    dbFile = join(root, 'baibao.db');
    store = new TextStore(dbFile);
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = () => ({
    gameDir: game,
    gameId: 'g1',
    adapter: mvmzAdapter,
    store,
    from: 'ja',
    to: 'zh-CN',
  });

  it('完整闭环：抽取 → 翻译 → 回写，且控制符完好', async () => {
    const rep = await runPipeline({ ...base(), provider: goodProvider, injectFont: true });

    // 6 条：gameTitle + terms.basic×2 + terms.messages + Actors.name + 事件对白
    expect(rep.extracted).toBe(6);
    expect(rep.alreadyApplied).toBe(0); // 首次运行，没有我们写回过的内容
    expect(rep.upsert.inserted).toBe(6);
    expect(rep.candidates).toBe(6);
    expect(rep.translated).toBe(6);
    expect(rep.conflicts).toBe(0);
    expect(rep.failed).toBe(0);
    expect(rep.errors).toEqual([]);

    // 回写
    expect(rep.repack?.written).toBe(6);
    expect(rep.repack?.errors).toEqual([]);

    // 游戏文件里译文到位，且 **控制符 \N[1] 完整保留**
    const ce = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'CommonEvents.json'), 'utf8'));
    expect(ce[1].list[0].parameters[0]).toBe(`【译】こんにちは、\\N[1]！`);
    expect(ce[1].list[0].parameters[0]).toContain('\\N[1]');

    const sys = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'System.json'), 'utf8'));
    expect(sys.gameTitle).toBe('【译】テストゲーム');
    expect(sys.terms.basic[0]).toBe('【译】レベル');
    expect(sys.terms.messages.actionFailure).toBe('【译】%1は失敗した！');

    // 字体注入
    expect(rep.font?.applied).toBe(true);
    expect(sys.locale).toBe('zh_CN');
    // ★ 字形覆盖校验：用真实译文当样本，确认本机能显示（"能看"的保证）
    expect(rep.font?.coverage).toBeDefined();
    expect(rep.font?.coverage?.ok).toBe(true);
    expect(rep.font?.coverage?.missing).toEqual([]);
    expect(rep.font?.notes.join(' ')).toContain('字形覆盖校验通过');

    // 库状态
    expect(store.stats('g1').byStatus.translated).toBe(6);
  });

  it('★ 安全阀：机翻弄坏控制符 → 标 conflict 且绝不写回游戏', async () => {
    const rep = await runPipeline({ ...base(), provider: badProvider });

    expect(rep.conflicts).toBe(1); // 只有那句带 \N[1] 的中招
    expect(rep.translated).toBe(5);
    expect(rep.repack?.written).toBe(5);

    // 关键：游戏文件里那句对白**保持原文原样**，控制符没被破坏
    const ce = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'CommonEvents.json'), 'utf8'));
    expect(ce[1].list[0].parameters[0]).toBe(DIALOGUE);
    expect(ce[1].list[0].parameters[0]).toContain('\\N[1]');

    // 冲突条目被记下来供人工处理（保留机翻结果，但状态是 conflict）
    const conflicts = store.list('g1', { status: 'conflict' });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].source).toBe(DIALOGUE);
    expect(conflicts[0].translated).toBe('【译】こんにちは、！');
  });

  it('断点续翻：第二次运行不会重复翻译（反向 TM 防护）', async () => {
    await runPipeline({ ...base(), provider: goodProvider });
    const second = await runPipeline({ ...base(), provider: goodProvider });

    // 第二次抽到的 6 条其实都是我们上一轮写回游戏的中文 → 必须全部识别并跳过，
    // 否则会变成 【译】【译】… 把游戏毁掉。
    expect(second.extracted).toBe(6);
    expect(second.alreadyApplied).toBe(6);
    expect(second.candidates).toBe(0);
    expect(second.translated).toBe(0);
    expect(second.upsert.inserted).toBe(0);
    expect(second.upsert.invalidated).toBe(0);
    // 译文没被再次改坏
    const ce = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'CommonEvents.json'), 'utf8'));
    expect(ce[1].list[0].parameters[0]).toBe(`【译】${DIALOGUE}`);
  });

  it('原文变更 → 自动打回 pending 并重译', async () => {
    await runPipeline({ ...base(), provider: goodProvider });
    // 把游戏里的一句原文改掉（模拟游戏更新）
    await fs.writeFile(
      join(game, 'www', 'data', 'Actors.json'),
      JSON.stringify([null, { id: 1, name: 'アーサー改' }]),
    );
    const rep = await runPipeline({ ...base(), provider: goodProvider });

    expect(rep.alreadyApplied).toBe(5); // 其余 5 条是我们写回的译文
    expect(rep.upsert.invalidated).toBe(1); // 改过的那条被打回
    expect(rep.candidates).toBe(1);
    expect(rep.translated).toBe(1);

    const ac = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'Actors.json'), 'utf8'));
    expect(ac[1].name).toBe('【译】アーサー改');
  });

  it('limit 可只翻前 N 条（试译）', async () => {
    const rep = await runPipeline({ ...base(), provider: goodProvider, limit: 2 });
    expect(rep.extracted).toBe(2);
    expect(rep.translated).toBe(2);
  });

  it('repack:false 时只入库不回写', async () => {
    const rep = await runPipeline({ ...base(), provider: goodProvider, repack: false });
    expect(rep.repack).toBeUndefined();
    const ce = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'CommonEvents.json'), 'utf8'));
    expect(ce[1].list[0].parameters[0]).toBe(DIALOGUE); // 游戏文件未动
    expect(store.stats('g1').byStatus.translated).toBe(6); // 但库里已译
  });

  it('Provider 抛错不炸整条流水线，错误被收集', async () => {
    const boom: TranslationProvider = {
      id: 'boom',
      displayName: '总是失败',
      async translate() {
        throw new Error('网络超时');
      },
    };
    const rep = await runPipeline({ ...base(), provider: boom });
    expect(rep.failed).toBe(6);
    expect(rep.translated).toBe(0);
    expect(rep.errors.join(' ')).toContain('网络超时');
    expect(rep.repack?.written).toBe(0);
  });
});

/** 会原样返回原文的假机翻（模拟"根本没翻"） */
const echoProvider: TranslationProvider = {
  id: 'echo',
  displayName: '原样返回',
  async translate(reqs) {
    return reqs.map((r) => ({ id: r.id, translated: r.source, provider: 'echo' }));
  },
};

describe('翻译内核：TM / 术语 / 质检 / 限流', () => {
  let root: string;
  let game: string;
  let store: TextStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'baibao-m2-'));
    game = join(root, 'game');
    await fs.mkdir(join(game, 'www', 'js'), { recursive: true });
    await fs.mkdir(join(game, 'www', 'data'), { recursive: true });
    await fs.writeFile(join(game, 'www', 'js', 'rpg_core.js'), '// mv');
    await fs.writeFile(
      join(game, 'www', 'data', 'System.json'),
      JSON.stringify({ gameTitle: 'テストゲーム', locale: 'ja_JP' }),
    );
    await fs.writeFile(
      join(game, 'www', 'data', 'CommonEvents.json'),
      JSON.stringify([
        null,
        { id: 1, name: 'x', list: [{ code: 401, indent: 0, parameters: ['アーサーは強い'] }] },
      ]),
    );
    store = new TextStore(join(root, 'db.sqlite'));
  });
  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const base = () => ({
    gameDir: game,
    gameId: 'm2',
    adapter: mvmzAdapter,
    store,
    from: 'ja',
    to: 'zh-CN',
  });

  it('TM 命中：复用已有译文，不送机翻（省钱）', async () => {
    // 预置一条翻译记忆（另一个 path，模拟"以前译过同样的话"）
    store.upsert('m2', [{ engine: 'mvmz', path: 'seed/x', key: 'k', source: 'テストゲーム', status: 'pending' }]);
    store.setTranslation('m2', 'seed/x', 'k', '测试游戏');

    const rep = await runPipeline({ ...base(), provider: goodProvider });
    expect(rep.candidates).toBe(2);
    expect(rep.fromCache).toBe(1); // gameTitle 命中 TM
    expect(rep.sentToProvider).toBe(1); // 只有对白送机翻
    expect(rep.translated).toBe(1); // translated 只计"经 Provider 成功翻译"的
    expect(rep.providerCalls).toBe(1);
    // 库里已译 3 条 = 预置的 TM 种子 + gameTitle + 对白
    expect(store.stats('m2').byStatus.translated).toBe(3);

    // 命中用的是 TM 里的译文，而不是机翻结果
    const sys = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'System.json'), 'utf8'));
    expect(sys.gameTitle).toBe('测试游戏');
  });

  it('useTM:false 时关闭翻译记忆', async () => {
    store.upsert('m2', [{ engine: 'mvmz', path: 'seed/x', key: 'k', source: 'テストゲーム', status: 'pending' }]);
    store.setTranslation('m2', 'seed/x', 'k', '测试游戏');
    const rep = await runPipeline({ ...base(), provider: goodProvider, useTM: false });
    expect(rep.fromCache).toBe(0);
    expect(rep.sentToProvider).toBe(2);
  });

  it('术语强制一致：掩码后机翻，还原成指定译法', async () => {
    const rep = await runPipeline({
      ...base(),
      provider: goodProvider,
      glossary: { アーサー: '亚瑟' },
    });
    expect(rep.translated).toBe(2);
    // 对白里的 アーサー 被强制翻译成"亚瑟"，且原文术语没留在译文里
    const ce = JSON.parse(await fs.readFile(join(game, 'www', 'data', 'CommonEvents.json'), 'utf8'));
    const line = ce[1].list[0].parameters[0] as string;
    expect(line).toContain('亚瑟');
    expect(line).not.toContain('アーサー');
    expect(line).not.toContain('__GT');
  });

  it('质检软警告：一字未译会被记录（内容相同 → 回写幂等跳过）', async () => {
    const rep = await runPipeline({ ...base(), provider: echoProvider });
    expect(rep.translated).toBe(2);
    expect(rep.conflicts).toBe(0);
    expect(rep.qualityWarnings.unchanged).toBeGreaterThanOrEqual(2);
    // 译文与原文一字不差 → 没有实际改动，回写正确地"零写入"
    expect(rep.repack?.written).toBe(0);
    expect(rep.repack?.unchanged).toBe(2);
  });

  it('质检软警告不阻止写回（长度比异常仍写）', async () => {
    const verbose: TranslationProvider = {
      id: 'verbose',
      displayName: '啰嗦机翻',
      async translate(reqs) {
        return reqs.map((r) => ({ id: r.id, translated: `${r.source}${'あ'.repeat(60)}`, provider: 'verbose' }));
      },
    };
    const rep = await runPipeline({ ...base(), provider: verbose });
    expect(rep.translated).toBe(2);
    expect(rep.conflicts).toBe(0);
    expect(rep.qualityWarnings['length-ratio']).toBeGreaterThanOrEqual(2);
    expect(rep.repack?.written).toBe(2); // 软问题不阻止
  });

  it('限流参数生效且仍完成全部批次', async () => {
    const rep = await runPipeline({
      ...base(),
      provider: goodProvider,
      batchSize: 1,
      rateLimit: { maxConcurrent: 1, minIntervalMs: 5 },
    });
    expect(rep.providerCalls).toBe(2);
    expect(rep.translated).toBe(2);
  });
});
