// ============================================================================
// 折行后"还放不下"的量化分析（离线，不需要跑游戏）
// ============================================================================
// 回答一个问题：**装了这个折行插件之后，还有多少文本放不下？**
//
// ★ 为什么这个分析是必要的
//   折行只解决**横向**溢出（一行放不下就断开）。
//   它**不解决纵向**：断出来的行数如果超过窗口可见行数，
//   消息窗口会触发分页（`needsNewPage`），非消息窗口会被垂直裁掉。
//   所以"折行上线后还剩多少问题"必须单独量一次 —— 这才是决定
//   "要不要继续做字号自适应"的依据（而不是凭感觉加功能）。
//
// 容量参数**来自实测**（tools/mv-runtime/BB_Probe.js 的输出）：
//   contents.width = 604px、fontSize = 24px、每字 24px → 每行 25 个全角字
//   Window_Message 可见 4 行 → 一屏 100 字
//
// 用法：
//   node tools/mv-runtime/analyze-fit.mjs "<翻译文件.json>" [--width 604] [--font 24] [--rows 4]
//   不带参数时按内置样本路径跑。
import fs from 'node:fs';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
};
const CONTENTS_W = num('--width', 604);
const FONT_PX = num('--font', 24);
const ROWS = num('--rows', 4);

if (!file) {
    console.error('用法：node tools/mv-runtime/analyze-fit.mjs "<翻译文件.json>" [--width 604] [--font 24] [--rows 4]');
    process.exit(2);
}

/** 显示宽度（全角=1、半角=0.5），用于估算像素宽 */
const dispWidth = (s) => {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0);
        const wide = c >= 0x1100 &&
            (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
             (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) ||
             (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
             (c >= 0x20000 && c <= 0x3fffd));
        n += wide ? 1 : 0.5;
    }
    return n;
};
/** 转义码不占显示宽度，量之前剥掉 */
const strip = (s) => s.replace(/\\[A-Za-z]{1,2}\[[0-9]+\]|\\./g, '');

const pxPerFull = FONT_PX;                    // 全角字宽 = 字号（实测如此）
const charsPerLine = Math.floor(CONTENTS_W / pxPerFull);
const charsPerScreen = charsPerLine * ROWS;

const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const keys = Object.keys(j).filter((k) => !/['";{}()=]/.test(k) && k.trim() !== '');

let n = 0, origOver = 0, transOver = 0, origPages = 0, transPages = 0;
let worstOrig = 0, worstTrans = 0, grew = 0;
const samples = [];
for (const k of keys) {
    const v = j[k];
    if (typeof v !== 'string') continue;
    n++;
    const wo = dispWidth(strip(k));
    const wt = dispWidth(strip(v));
    const lo = Math.ceil(wo / charsPerLine);
    const lt = Math.ceil(wt / charsPerLine);
    if (lo > ROWS) origPages++; else if (lo > 1) origOver++;
    if (lt > ROWS) transPages++; else if (lt > 1) transOver++;
    if (lt > worstTrans) worstTrans = lt;
    if (lo > worstOrig) worstOrig = lo;
    if (wt > wo) grew++;
    if (lt > lo && samples.length < 6) samples.push({ k, v, lo, lt });
}

const pc = (x) => ((100 * x) / n).toFixed(2) + '%';
console.log('=== 折行后的容量分析 ===');
console.log('容量参数：contents.width=' + CONTENTS_W + 'px，字号=' + FONT_PX + 'px');
console.log('        → 每行 ' + charsPerLine + ' 个全角字；可见 ' + ROWS + ' 行 → 一屏 ' + charsPerScreen + ' 字');
console.log('样本条数 =', n);
console.log('');
console.log('【原文】');
console.log('  需要 2~' + ROWS + ' 行（折行可解决）   :', origOver, pc(origOver));
console.log('  超过 ' + ROWS + ' 行（会分页/裁掉）    :', origPages, pc(origPages));
console.log('  最多需要行数                     :', worstOrig);
console.log('');
console.log('【译文】');
console.log('  需要 2~' + ROWS + ' 行（折行可解决）   :', transOver, pc(transOver));
console.log('  超过 ' + ROWS + ' 行（**折行也解决不了**）:', transPages, pc(transPages));
console.log('  最多需要行数                     :', worstTrans);
console.log('');
console.log('译文比原文更宽的条数 =', grew, pc(grew));
console.log('');
console.log('=== 折行后行数变多、且刚好跨过 ' + ROWS + ' 行门槛的例子 ===');
for (const s of samples.filter((x) => x.lt > x.lo)) {
    console.log('  原文 ' + s.lo + ' 行 → 译文 ' + s.lt + ' 行 : ' + JSON.stringify(s.k).slice(0, 46));
}
