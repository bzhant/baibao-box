/**
 * MV/MZ 事件对白抽取 + 指针回写 的内存级端到端自检。
 * 只依赖 event-text.ts（自包含），用 node --experimental-strip-types 直跑。
 * 用法： node --experimental-strip-types scripts/verify-mvmz.ts
 */
import { extractEventText, isEventFile } from '../src/engines/mvmz/event-text.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ''); }
}

// ── 仿真 MV/MZ 数据结构 ─────────────────────────────────────
const commonEvents = [null, {
  id: 1, name: '挨拶', list: [
    { code: 101, indent: 0, parameters: ['', 0, 0, 2] },            // 文本设置(不可译)
    { code: 401, indent: 0, parameters: ['こんにちは、\\N[1]！'] },  // 对白(可译)
    { code: 102, indent: 0, parameters: [['はい', 'いいえ'], 0, 0, 2, 0] }, // 选项(可译)
    { code: 355, indent: 0, parameters: ['$game_variables[1]=1'] },  // 脚本(不可译)
    { code: 250, indent: 0, parameters: [{ name: 'Bell', volume: 90, pitch: 100 }] }, // 音效资源(不可译)
  ],
}];

const troops = [null, {
  id: 1, name: 'スライム*2', pages: [
    { list: [{ code: 401, indent: 0, parameters: ['敵が現れた！'] }] },
  ],
}];

const map001 = {
  displayName: '始まりの村',
  events: [null, {
    id: 1, name: '村人', pages: [
      { list: [
        { code: 401, indent: 0, parameters: ['ようこそ、\\C[2]旅人\\C[0]。'] },
        { code: 405, indent: 0, parameters: ['スクロール文'] },
      ] },
    ],
  }],
};

// ── 1. 抽取正确性 ───────────────────────────────────────────
const ceSlots = [...extractEventText('CommonEvents.json', commonEvents)];
const troopSlots = [...extractEventText('Troops.json', troops)];
const mapSlots = [...extractEventText('Map001.json', map001)];

check('公共事件抽取 3 条（1 对白 + 2 选项，脚本/音效被排除）', ceSlots.length === 3, ceSlots.map(s => s.source));
check('敌群抽取 1 条', troopSlots.length === 1, troopSlots.map(s => s.source));
check('地图抽取 2 条（401 + 405）', mapSlots.length === 2, mapSlots.map(s => s.source));

const ceSources = ceSlots.map(s => s.source);
check('公共事件含对白原文（控制符保留）', ceSources.includes('こんにちは、\\N[1]！'), ceSources);
check('公共事件含两个选项', ceSources.includes('はい') && ceSources.includes('いいえ'), ceSources);
check('地图对白控制符 \\C[2] 完整保留', mapSlots[0]?.source === 'ようこそ、\\C[2]旅人\\C[0]。', mapSlots[0]);

// ── 2. 指针定位正确（能指回原槽位）─────────────────────────
function getByPointer(root: unknown, segs: string[]): unknown {
  let node: any = root;
  for (const s of segs) { if (node == null) return undefined; node = node[s]; }
  return node;
}
{
  const dialogue = ceSlots.find(s => s.key === 'cmd401')!;
  check('对白指针可指回原文', getByPointer(commonEvents, dialogue.pointer) === 'こんにちは、\\N[1]！', dialogue.pointer);
  const choice0 = ceSlots.filter(s => s.key === 'choice')[0];
  check('选项指针可指回原文', getByPointer(commonEvents, choice0.pointer) === 'はい', choice0.pointer);
  const map401 = mapSlots.find(s => s.key === 'cmd401')!;
  check('地图指针可指回原文', getByPointer(map001, map401.pointer) === 'ようこそ、\\C[2]旅人\\C[0]。', map401.pointer);
}

// ── 3. 回写仿真（翻译 + 指针写回 + 控制符不丢）──────────────
function setByPointer(root: unknown, segs: string[], value: string): boolean {
  let node: any = root;
  for (let i = 0; i < segs.length - 1; i++) { if (node == null) return false; node = node[segs[i]]; }
  if (node == null) return false;
  const leaf = segs[segs.length - 1];
  if (typeof node[leaf] !== 'string') return false;
  node[leaf] = value;
  return true;
}
{
  const clone = JSON.parse(JSON.stringify(commonEvents));
  let written = 0;
  for (const s of ceSlots) {
    if (setByPointer(clone, s.pointer, `【译】${s.source}`)) written++;
  }
  check('回写条数 == 抽取条数', written === ceSlots.length, { written, expect: ceSlots.length });
  const out = clone[1].list[1].parameters[0];
  check('回写后控制符 \\N[1] 仍在', out === '【译】こんにちは、\\N[1]！', out);
  const outChoice = clone[1].list[2].parameters[0][0];
  check('选项数组元素被单独回写', outChoice === '【译】はい', outChoice);
  // 结构未被破坏：脚本/音效指令原样
  check('脚本指令未被改动', clone[1].list[3].parameters[0] === '$game_variables[1]=1');
  check('音效指令未被改动', clone[1].list[4].parameters[0].name === 'Bell');
}

// ── 4. isEventFile 判别 ─────────────────────────────────────
check('isEventFile 识别', isEventFile('CommonEvents.json') && isEventFile('Map003.json') && !isEventFile('Actors.json'));

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
