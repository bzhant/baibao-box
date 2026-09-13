import { registerBuiltinPlugins } from './bootstrap-plugins';
import {
  detectGame,
  gameIdOf,
  previewRepack,
  repackGame,
  restoreGame,
  runTranslate,
  dbPath,
  type TranslateOutcome,
} from './translate-service';
import type { PipelineProgress } from '../pipeline/translate-pipeline';

/**
 * 命令行入口（headless）：`npm run translate -- --game <游戏目录> [选项]`
 *
 * 为什么走 Electron 而不是 Node：
 *  better-sqlite3 是原生模块，Node 与 Electron 的 ABI 不同。用 Electron 跑，
 *  ABI 天然正确，也复用主进程的全部代码（与 `npm run smoke` 同一套路子）。
 *
 * ★ 本文件**只做两件事**：解析参数、把结果排版到 stdout。
 *   真正的编排在 `translate-service.ts`，与图形界面**共用同一套实现**。
 *
 *   为什么必须共用：编排里有不少"不看代码就会写错"的判断（引擎置信度、
 *   数据加密要早退、Provider 不隐式联网、还原语义）。两个入口各写一份，
 *   迟早分叉 —— 而分叉的典型症状是"命令行能跑、点按钮不对"（或反之），
 *   这类问题极难查，因为两边单看都"像是对的"。
 *
 * 选项：
 *   --game <dir>      必填，游戏目录
 *   --limit <n>       只处理前 N 条（试译）
 *   --no-repack       只入库不回写（先看抽得对不对）
 *   --font            注入中文字体（解决译文方框）
 *   --restore         还原最近的字体/回写补丁后退出（红线：可逆）
 *   --from / --to     源语言 / 目标语言，默认 ja → zh-CN
 *   --provider <id>   openai | stub（默认：有密钥用 openai，否则 stub）
 */

export { gameIdOf };

interface CliArgs {
  game?: string;
  limit?: number;
  repack: boolean;
  font: boolean;
  restore: boolean;
  from: string;
  to: string;
  provider?: string;
  /** 只回写：不抽取、不翻译，把库里已译/已复核的译文落到游戏文件 */
  repackOnly: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    repack: true, font: false, restore: false, repackOnly: false,
    from: 'ja', to: 'zh-CN', help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--game': args.game = next(); break;
      case '--limit': args.limit = Number(next()) || undefined; break;
      case '--no-repack': args.repack = false; break;
      case '--font': args.font = true; break;
      case '--restore': args.restore = true; break;
      case '--repack-only': args.repackOnly = true; break;
      case '--from': args.from = next() ?? args.from; break;
      case '--to': args.to = next() ?? args.to; break;
      case '--provider': args.provider = next(); break;
      case '--help':
      case '-h': args.help = true; break;
      default: break;
    }
  }
  return args;
}

const HELP = `
白的百宝箱 · 汉化命令行

用法：
  npm run translate -- --game "<游戏目录>" [选项]

选项：
  --game <目录>     必填。RPG Maker MV/MZ、Ren'Py 游戏目录
  --limit <n>       只处理前 N 条（先试译一小段）
  --no-repack       只抽取入库、不回写游戏（先检查抽得对不对）
  --font            注入中文字体（解决译文变方框）
  --restore         还原最近的字体/回写补丁（可逆），做完即退出
  --repack-only     只回写：把库里已译/已复核的译文落到游戏文件（不抽取、不翻译）
  --from <lang>     源语言，默认 ja
  --to <lang>       目标语言，默认 zh-CN
  --provider <id>   openai | stub（默认：有 BAIBAO_OPENAI_API_KEY 用 openai，否则 stub）

示例：
  npm run translate -- --game "E:\\games\\某游戏" --limit 30
  npm run translate -- --game "E:\\games\\某游戏" --font
  npm run translate -- --game "E:\\games\\某游戏" --restore
`;

/** 把一次汉化的结果排版到 stdout */
function printReport(o: TranslateOutcome): void {
  const r = o.report;
  console.log('\n──── 结果 ────────────────────────────');
  console.log(`  引擎            ${o.engineName}（${o.engineId}）`);
  console.log(`  Provider        ${o.providerName}`);
  console.log(`  抽取            ${r.extracted}`);
  console.log(`  已是我们写回的   ${r.alreadyApplied}`);
  console.log(`  新增入库        ${r.upsert.inserted}`);
  console.log(`  原文变更重译    ${r.upsert.invalidated}`);
  console.log(`  待译            ${r.candidates}`);
  console.log(`  翻译成功        ${r.translated}`);
  console.log(`  控制符冲突      ${r.conflicts}   ← 已拒绝写回，需人工处理`);
  console.log(`  翻译失败        ${r.failed}`);
  if (r.repack) {
    console.log(`  回写            ${r.repack.written}（已是目标值跳过 ${r.repack.unchanged}，其它跳过 ${r.repack.skipped}）`);
    if (r.repack.backupDir) console.log(`  备份            ${r.repack.backupDir}`);
  }
  if (r.font) {
    console.log(`  字体            ${r.font.detail}`);
    for (const n of r.font.notes) console.log(`                  · ${n}`);
  }
  console.log(`  耗时            ${r.durationMs}ms（含准备共 ${o.durationMs}ms）`);
  if (r.errors.length) {
    console.log('\n  错误：');
    for (const e of r.errors) console.log(`    ✗ ${e}`);
  }
  console.log('──────────────────────────────────────');
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help || !args.game) {
    console.log(HELP);
    return args.help ? 0 : 2;
  }

  registerBuiltinPlugins(); // 幂等

  try {
    // ── 还原模式 ──
    if (args.restore) {
      console.log(`还原补丁：${args.game}`);
      const r = await restoreGame(args.game);
      if (r.nothingToDo) {
        console.log('  没有需要还原的改动。');
        return 0;
      }
      console.log(`  展开 ${r.patches} 个补丁，还原 ${r.restored} 个文件`);
      for (const e of r.errors) console.error(`  ✗ ${e}`);
      console.log(r.errors.length ? '还原完成，但有错误（见上）。' : '还原完成（已回到翻译前状态）。');
      return r.errors.length ? 1 : 0;
    }

    // ── 只回写模式（把工作台里改好的译文落进游戏，不重跑整条流水线）──
    if (args.repackOnly) {
      const pv = await previewRepack(args.game);
      console.log(`引擎：${pv.engineName}（${pv.engineId}）`);
      console.log(
        `将要回写 ${pv.willWrite} 条　（已译 ${pv.counts.translated} / 已复核 ${pv.counts.reviewed}` +
        ` / 未译 ${pv.counts.pending} 不写` +
        (pv.counts.conflict ? ` / 冲突 ${pv.counts.conflict} 不写` : '') + '）',
      );
      if (!pv.supported) {
        console.error(`✗ ${pv.reason ?? '这个引擎不支持静态回写。'}`);
        return 4;
      }
      if (pv.willWrite === 0) {
        console.log('  没有可回写的条目（库里没有已译/已复核的条目）。');
        return 0;
      }
      const out = await repackGame(args.game, (p2) => {
        if (p2.phase === 'repack') process.stdout.write(`\r  回写 ${p2.current}/${p2.total}  `);
      });
      process.stdout.write('\n');
      const r = out.repack;
      console.log(`  写入 ${r.written} · 无需改动 ${r.unchanged} · 跳过 ${r.skipped}`);
      if (r.backupDir) console.log(`  备份 ${r.backupDir}`);
      for (const n of r.notes ?? []) console.log(`  · ${n}`);
      for (const e of r.errors) console.error(`  ✗ ${e}`);
      return r.errors.length ? 1 : 0;
    }

    // ── 先探测引擎 ──
    //   识别失败 / 数据被加密要**立刻**说清楚，不要跑了一半才报错。
    const det = await detectGame(args.game);
    if (!det.ok) {
      console.error(`✗ 没识别出引擎（目录：${args.game}）`);
      if (det.candidates.length) console.error(`  最接近的候选：${det.candidates.join(', ')}`);
      if (det.message) console.error(`  ${det.message}`);
      return 3;
    }
    console.log(`引擎：${det.engineName}（${det.engineId}）置信度 ${det.confidence}`);
    for (const n of det.notes) console.log(`  · ${n}`);
    if (det.encrypted) {
      console.error('✗ 该游戏的数据文件被加密，静态抽取不可用（需运行时提取）。已中止。');
      return 4;
    }

    console.log(`文本库：${dbPath()}`);
    console.log(`gameId：${det.gameId}\n`);

    // 进度输出节流：只在"阶段切换"或"进度跨过 5% 台阶"时刷新，
    // 否则几千条会刷屏（日志里尤其难看）。
    let lastKey = '';
    const onProgress = (p: PipelineProgress): void => {
      const step = p.total > 0 ? Math.floor((p.current / p.total) * 20) : 20; // 5% 一档
      const key = `${p.phase}:${step}:${p.message ?? ''}`;
      if (key === lastKey) return;
      lastKey = key;
      const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 100;
      process.stdout.write(
        `\r  ${p.phase.padEnd(9)} ${String(pct).padStart(3)}%  ${p.message ?? ''}`.padEnd(78),
      );
      if (p.phase === 'done') process.stdout.write('\n');
    };

    const out = await runTranslate(
      {
        gameDir: args.game,
        from: args.from,
        to: args.to,
        limit: args.limit,
        repack: args.repack,
        injectFont: args.font,
        providerId: args.provider,
      },
      onProgress,
    );
    process.stdout.write('\n');
    if (out.autoStub) {
      console.log('提示：未检测到 BAIBAO_OPENAI_API_KEY，使用本地假机翻（只验证流程，不做真翻译）。');
    }

    printReport(out);
    return out.report.errors.length ? 1 : 0;
  } catch (err) {
    console.error(`✗ 执行失败：${(err as Error).message}`);
    return 1;
  }
}
