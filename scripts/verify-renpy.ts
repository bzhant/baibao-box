/**
 * Ren'Py .rpy 解析 + 原地回写 的内存级自检。
 * 只依赖 rpy-parse.ts（零依赖），用 node --experimental-strip-types 直跑。
 * 用法： node --experimental-strip-types scripts/verify-renpy.ts
 */
import {
  extractRpySlots,
  parseRpyLine,
  replaceRpyLiteral,
  stripComment,
  splitLiterals,
  escapeForRpy,
} from '../src/engines/renpy/rpy-parse.ts';
import { mask, unmask } from '../src/text-kernel/control-codes.ts';
import { patternFor } from '../src/text-kernel/patterns.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ''); }
}

const SCRIPT = [
  'define e = Character("Eileen", color="#ffffff")',   // 1  角色显示名（第 1 个字符串）
  '# 这是注释，不该被抽',
  'label start:',
  '    scene bg room',
  '    show eileen happy',
  '    play music "bgm/title.ogg"',                    // 6  资源名，不该被抽
  '',
  '    "It\'s a new day."',                            // 8  旁白
  '    e "Hello, [player_name]!"',                     // 9  对白（含插值控制符）
  '    e (what_color="#fff") "Colored line {b}bold{/b}"', // 10 对白（第 2 个字符串）
  '    "价格 #1 的说明"',                                // 11 字符串里的 # 不是注释
  '    "He said \\"hi\\" to me."',                       // 12 转义引号
  '    $ x = "不该抽的脚本字符串"',                       // 13 $ 脚本行
  '    if x == "a":',                                   // 14 条件行
  '    extend "  续写上一句。"',                          // 15 extend
  '    menu:',
  '        "出门":',                                     // 17 选项
  '            jump outside',
  '        "留下":',                                     // 19 选项
  '            pass',
].join('\n');

// ── 1. 基础扫描器 ───────────────────────────────────────────
{
  const { lits, allClosed } = splitLiterals('define e = Character("Eileen", color="#fff")');
  check('切出 2 个字符串', allClosed && lits.length === 2, lits.map((l) => l.raw));
  check('第 1 个是显示名', lits[0].raw === 'Eileen', lits[0].raw);
}
check('字符串内的 # 不当注释', stripComment('"价格 #1 的说明"') === '"价格 #1 的说明"');
check('行尾注释被切掉', stripComment('    e "hi"  # 注释').trim() === 'e "hi"');

// ── 2. 逐行类型判定 ─────────────────────────────────────────
const kinds: Array<[number, string | null]> = [
  [1, 'name'], [3, null], [4, null], [5, null], [6, null],
  [8, 'narration'], [9, 'say'], [10, 'say'], [11, 'narration'], [12, 'narration'],
  [13, null], [14, null], [15, 'extend'], [17, 'choice'], [19, 'choice'],
];
const lines = SCRIPT.split('\n');
for (const [ln, expectKind] of kinds) {
  const slot = parseRpyLine(lines[ln - 1], ln);
  check(`L${ln} 判定为 ${expectKind ?? '跳过'}`, (slot?.kind ?? null) === expectKind, slot);
}

// ── 3. 抽取结果 ─────────────────────────────────────────────
const slots = extractRpySlots(SCRIPT);
check('共抽到 9 条', slots.length === 9, slots.map((s) => `L${s.line}:${s.kind}=${s.source}`));
const byLine = new Map(slots.map((s) => [s.line, s]));
check('L9 对白原文正确', byLine.get(9)?.source === 'Hello, [player_name]!', byLine.get(9));
check('L10 取的是第 2 个字符串（对白而非颜色）', byLine.get(10)?.source === 'Colored line {b}bold{/b}', byLine.get(10));
check('L12 转义引号被逐字保留', byLine.get(12)?.source === 'He said \\"hi\\" to me.', byLine.get(12));
check('L11 含 # 的字符串完整', byLine.get(11)?.source === '价格 #1 的说明', byLine.get(11));
check('L1 显示名为 Eileen', byLine.get(1)?.source === 'Eileen', byLine.get(1));

// ── 4. 回写：原文回填必须逐字等于原行（不破坏文件）──────────
{
  let same = 0;
  for (const s of slots) {
    const next = replaceRpyLiteral(lines[s.line - 1], s.ordinal, s.source);
    if (next === lines[s.line - 1]) same++;
    else console.log(`    L${s.line} 回填不一致:`, JSON.stringify(next), '!=', JSON.stringify(lines[s.line - 1]));
  }
  check('9 条原文回填后文件逐字不变', same === slots.length, { same, total: slots.length });
}

// ── 5. 回写：译入后控制符不丢、其它行不受影响 ────────────────
{
  const out = [...lines];
  for (const s of slots) out[s.line - 1] = replaceRpyLiteral(out[s.line - 1], s.ordinal, `【译】${s.source}`)!;
  const text = out.join('\n');
  check('译文已写入', text.includes('【译】Hello, [player_name]!'));
  check('插值控制符 [player_name] 未丢', text.includes('Hello, [player_name]!'));
  check('文本标签 {b}{/b} 未丢', text.includes('{b}bold{/b}'));
  check('转义引号未损坏', text.includes('He said \\"hi\\" to me.'));
  check('注释行原样', text.includes('# 这是注释，不该被抽'));
  check('资源行原样', text.includes('play music "bgm/title.ogg"'));
  check('脚本行原样', text.includes('$ x = "不该抽的脚本字符串"'));
  check('escapeForRpy 不动已转义引号', escapeForRpy('He said \\"hi\\"') === 'He said \\"hi\\"');
  check('escapeForRpy 转义裸引号', escapeForRpy('他说 "你好"') === '他说 \\"你好\\"');
}

// ── 6. 内核按引擎选控制符模式（Ren\'Py 模式）────────────────
{
  const src = '你好，[player_name]！{b}加粗{/b}';
  const { masked, tokens } = mask(src, patternFor('renpy'));
  check('Ren\'Py 控制符被占位', !masked.includes('[player_name]') && !masked.includes('{b}'), masked);
  check('Ren\'Py 控制符可还原', unmask(masked, tokens) === src, unmask(masked, tokens));
  const { masked: rmMasked } = mask('こんにちは\\N[1]', patternFor('mvmz'));
  check('MV/MZ 模式仍工作', rmMasked === 'こんにちは__BB0__', rmMasked);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
