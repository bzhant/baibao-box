/**
 * 控制符模块的快速自检（不依赖 vitest，用 node --experimental-strip-types 直跑）。
 * 用法： node --experimental-strip-types scripts/verify-control-codes.ts
 */
import {
  tokenize,
  mask,
  unmask,
  missingPlaceholders,
  defaultPlaceholder,
} from '../src/text-kernel/control-codes.ts';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`, extra ?? ''); }
}

// 1. 无损切分
const losslessCases = [
  'こんにちは\\N[1]、元気？',
  '\\C[1]\\I[5]赤い\\C[0]薬',
  '\\{大きい\\}普通\\{さらに\\}',
  'パス\\\\tmp\\V[42]',
  'タグ<color=red>赤</color>と\\N[2]',
  '制御符なしの普通文本',
  '',
];
for (const src of losslessCases) {
  const joined = tokenize(src).map((s) => s.value).join('');
  check(`lossless ${JSON.stringify(src)}`, joined === src, { joined });
}

// 2. 控制符识别
{
  const tokens = tokenize('\\N[1]は\\C[2]こんにちは\\C[0]\\{！\\}')
    .filter((s) => s.kind === 'token').map((s) => s.value);
  check('tokens 识别', JSON.stringify(tokens) === JSON.stringify(['\\N[1]', '\\C[2]', '\\C[0]', '\\{', '\\}']), tokens);
}

// 3. round-trip
const rtCases = [
  'こんにちは\\N[1]、元気？',
  '\\C[1]\\I[5]赤い\\C[0]薬',
  '前\\V[1]中\\V[2]後',
  '変数\\V[10]とアイコン\\I[3]と色\\C[5]',
];
for (const src of rtCases) {
  const { masked, tokens } = mask(src);
  const noCodeLeft = !/\\[A-Za-z]/.test(masked);
  const restored = unmask(masked, tokens);
  check(`round-trip ${JSON.stringify(src)}`, noCodeLeft && restored === src, { masked, restored });
}

// 4. 占位符错位检查
{
  const src = 'A\\V[1]B\\V[2]C\\V[3]D';
  const { masked } = mask(src);
  const expected = `A${defaultPlaceholder(0)}B${defaultPlaceholder(1)}C${defaultPlaceholder(2)}D`;
  check('占位符顺序', masked === expected, { masked, expected });
}

// 5. 缺失检测
{
  const okAll = missingPlaceholders(`你好${defaultPlaceholder(0)}，${defaultPlaceholder(1)}`, 2);
  const missing = missingPlaceholders(`你好${defaultPlaceholder(0)}世界`, 2);
  check('缺失检测-全存活', okAll.length === 0, okAll);
  check('缺失检测-定位', JSON.stringify(missing) === JSON.stringify([1]), missing);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
