/**
 * pretest：保证 better-sqlite3 能在**当前 Node** 下加载。
 *
 * 背景：better-sqlite3 是原生模块，Node 与 Electron 的 ABI（NODE_MODULE_VERSION）不同。
 *  - `npm run dist` / `npm i` 时 electron-builder 会把它重编成 **Electron ABI** → 应用能用；
 *  - 但之后在 Node 里跑 vitest 就会报 "was compiled against a different Node.js version"。
 * 这个脚本先探测、不通就重编回 Node ABI，让 `npm test` 永远可用（自愈，不白跑）。
 *
 * 代价：每次打包后会触发一次重编（约 1~2 分钟）；之后测试很快。
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const require = createRequire(import.meta.url);

/**
 * 探测 better-sqlite3 在当前 Node 下是否真的可用。
 *
 * ⚠️ 关键：better-sqlite3 对原生绑定是**懒加载**的——
 * `require('better-sqlite3')` 会成功，直到 `new Database()` 才真正 dlopen 那个 .node。
 * 所以只 require 会误判成"可用"。必须**真的实例化一次**才能测出 ABI 是否匹配。
 */
function canLoad() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

if (canLoad()) {
  process.exit(0);
}

console.log('[pretest] better-sqlite3 当前 ABI 与 Node 不匹配（多半是打包时被改成 Electron ABI），重编中…');

// 优先用 npm 自己（npm run 时 npm_execpath 一定在），避免 PATH 里有问题时找不到 npm
const npmCli = process.env.npm_execpath;
const cmd = npmCli
  ? `"${process.execPath}" "${npmCli}" rebuild better-sqlite3`
  : 'npm rebuild better-sqlite3';

try {
  execSync(cmd, { stdio: 'inherit' });
} catch (err) {
  console.error('[pretest] 重编失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}

if (canLoad()) {
  console.log('[pretest] 重编完成，better-sqlite3 可用于 Node。');
  process.exit(0);
}
console.error('[pretest] 重编后仍无法加载，请检查原生模块构建环境。');
process.exit(1);
