import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { logError, logInfo, logWarn } from '@platform/logbus';
import type { ActivationContext, RuntimeActivation, RuntimeActivator } from './index';

/**
 * MV / MZ 的"激活方式"：**可逆地装一个运行时桥插件**，然后启动游戏。
 *
 * 为什么不是注入 DLL：
 *   MV/MZ 跑在 NW.js 上，文本是 JS 字符串，从数据到画面不经过任何原生文本 API ——
 *   编码层 hook 在这类引擎上**看不见东西**。引擎侧的拦截点只能在 JS 层。
 *   所以这两个引擎的"注入"= 把桥插件装进游戏，退出时逐字节还原。
 *
 * 这套"备份 → 装 → 跑 → 逐字节校验还原"的规矩是从 `tools/mv-runtime/run.mjs` 搬过来的，
 * 那里的三条教训一条都不能丢：
 *   ① **还原要校验哈希**："执行了还原"和"还原对了"是两件事；
 *   ② **拒绝覆盖同名插件** —— 本机那个游戏自己就有 `BB_*` 插件，
 *      万一同名，装进去再删掉就等于**把游戏自己的插件删了**；
 *   ③ **只用字符串追加**改 `plugins.js`，不 JSON.parse/stringify 重写
 *      （那会把游戏原有的注释和格式全改掉）。
 */

export type MvmzEngine = 'MV' | 'MZ';

export interface MvmzLayout {
  engine: MvmzEngine;
  /** 含 js/ 的那一层目录（MV 常见是 www） */
  wwwDir: string;
  pluginsJs: string;
  pluginsDir: string;
  exePath: string;
}

const CORE_CANDIDATES: Array<[string, MvmzEngine]> = [
  ['www/js/rpg_core.js', 'MV'],
  ['js/rpg_core.js', 'MV'],
  ['www/js/rmmz_core.js', 'MZ'],
  ['js/rmmz_core.js', 'MZ'],
];

/** 识别 MV/MZ 的目录布局；不是这两代引擎就返回 null。 */
export function detectMvmzLayout(gameDir: string): MvmzLayout | null {
  for (const [rel, engine] of CORE_CANDIDATES) {
    const core = join(gameDir, rel);
    if (!existsSync(core)) continue;
    const wwwDir = join(gameDir, rel.split('/')[0] === 'www' ? 'www' : '.');
    return {
      engine,
      wwwDir,
      pluginsJs: join(wwwDir, 'js', 'plugins.js'),
      pluginsDir: join(wwwDir, 'js', 'plugins'),
      exePath: join(gameDir, 'Game.exe'),
    };
  }
  return null;
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** 我们写进 plugins.js 的注册片段（**必须能精确定位**，恢复时靠它兜底） */
function registrationFragment(pluginName: string): string {
  return `\n{"name":"${pluginName}","status":true,"description":"BB runtime bridge (temporary)","parameters":{"Enabled":"true"}}\n`;
}

function skipTrivia(src: string, start: number): number {
  let i = start;
  for (;;) {
    while (/\s/.test(src[i] ?? '')) i++;
    if (src[i] === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i + 2);
      if (i < 0) return src.length;
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      return end < 0 ? src.length : skipTrivia(src, end + 2);
    }
    return i;
  }
}

function findPluginsArrayStart(src: string): number {
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (!src.startsWith('$plugins', i)) continue;
    if (/[\w$]/.test(src[i - 1] ?? '') || /[\w$]/.test(src[i + 8] ?? '')) continue;
    let cursor = skipTrivia(src, i + 8);
    if (src[cursor] !== '=') continue;
    cursor = skipTrivia(src, cursor + 1);
    if (src[cursor] === '[') return cursor;
  }
  return -1;
}

export function findPluginsArrayEnd(src: string): number {
  const start = findPluginsArrayStart(src);
  if (start < 0) return -1;
  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
    } else if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
    } else if (ch === '[') {
      depth++;
    } else if (ch === ']' && --depth === 0) {
      return i;
    }
  }
  return -1;
}

/** 关掉 Chromium 的后台节流 —— 否则非前台窗口的 rAF 被节流，MV/MZ 永远不就绪（且不报错）。 */
const CHROMIUM_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
];

export interface MvmzInstallResult {
  layout: MvmzLayout;
  /** 我们装进去的插件名（不含 .js） */
  pluginName: string;
  /** plugins.js 备份文件路径（万一异常退出，可据此手工还原） */
  backupPath: string;
  origSha: string;
  /** 追加进 plugins.js 的那段原文（恢复时精确匹配用） */
  fragment: string;
}

/**
 * 把桥插件装进游戏（可逆）。**不启动游戏** —— 便于单独验证安装/还原。
 */
export function installMvmzBridge(gameDir: string, bridgePath: string): MvmzInstallResult {
  const layout = detectMvmzLayout(gameDir);
  if (!layout) throw new Error(`"${gameDir}" 不是 RPG Maker MV/MZ（找不到 js/rpg_core.js 或 js/rmmz_core.js）`);
  if (!existsSync(layout.pluginsJs)) throw new Error(`找不到 ${layout.pluginsJs}`);
  if (!existsSync(layout.exePath)) throw new Error(`找不到游戏可执行文件 ${layout.exePath}`);
  if (!existsSync(bridgePath)) throw new Error(`找不到桥插件 ${bridgePath}`);

  const pluginName = basename(bridgePath).replace(/\.js$/, '');
  const dst = join(layout.pluginsDir, `${pluginName}.js`);

  // ② 拒绝覆盖同名插件（否则还原时会把游戏自己的插件删掉）
  if (existsSync(dst)) {
    throw new Error(
      `游戏目录里已存在同名插件 ${pluginName}.js，拒绝安装。\n` +
        `       请先确认它是否属于游戏；若是上次异常退出留下的，可先执行运行时还原。位置：${dst}`,
    );
  }

  const origBytes = readFileSync(layout.pluginsJs);
  const origSha = sha256(origBytes);
  const backupDir = mkdtempSync(join(tmpdir(), 'bb-runtime-'));
  const backupPath = join(backupDir, 'plugins.js.orig');
  writeFileSync(backupPath, origBytes);

  copyFileSync(bridgePath, dst);

  // ③ 字符串追加，不重写整个文件
  const src = origBytes.toString('utf8');
  const arrEnd = findPluginsArrayEnd(src);
  if (arrEnd < 0) throw new Error('plugins.js 里找不到 $plugins 数组的结尾 ]');
  const fragment = registrationFragment(pluginName);
  const entry = fragment.trimEnd();
  const newText = src.slice(0, arrEnd).replace(/[\s,]*$/, '') + ',' + entry + src.slice(arrEnd);
  writeFileSync(layout.pluginsJs, newText, 'utf8');

  logInfo('runtime', `已装运行时桥：${pluginName}.js（${layout.engine}），plugins.js 备份在 ${backupPath}`);
  return { layout, pluginName, backupPath, origSha, fragment: fragment.trimEnd() };
}

/**
 * 还原：优先用备份逐字节恢复并**校验哈希**；没有备份时退化为"精确摘掉我们那段注册 + 删掉插件文件"。
 * 这样即使进程被强杀，也能靠 `--runtime-restore` 把现场收干净。
 */
export function uninstallMvmzBridge(gameDir: string, backupPath?: string): { restored: boolean; how: string } {
  const layout = detectMvmzLayout(gameDir);
  if (!layout) throw new Error(`"${gameDir}" 不是 RPG Maker MV/MZ`);

  const pluginFiles = ['BB_RuntimeBridge.js'];
  let how = '';

  if (backupPath && existsSync(backupPath)) {
    const orig = readFileSync(backupPath);
    copyFileSync(backupPath, layout.pluginsJs);
    const now = sha256(readFileSync(layout.pluginsJs));
    if (now !== sha256(orig)) {
      throw new Error(`plugins.js 还原后哈希不一致（期望 ${sha256(orig).slice(0, 12)}…，实际 ${now.slice(0, 12)}…）`);
    }
    how = '按备份逐字节还原（哈希一致）';
  } else {
    let text = readFileSync(layout.pluginsJs, 'utf8');
    let removed = 0;
    for (const f of pluginFiles) {
      const frag = registrationFragment(f.replace(/\.js$/, '')).trimEnd();
      const at = text.indexOf(frag);
      if (at >= 0) {
        // 连同前面那个逗号一起摘掉
        const start = at > 0 && text[at - 1] === ',' ? at - 1 : at;
        text = text.slice(0, start) + text.slice(at + frag.length);
        removed += 1;
      }
    }
    writeFileSync(layout.pluginsJs, text, 'utf8');
    how = removed > 0 ? `按注册片段摘除（${removed} 处）` : '没有找到我们的注册片段（可能已还原）';
  }

  for (const f of pluginFiles) {
    const p = join(layout.pluginsDir, f);
    if (existsSync(p)) {
      unlinkSync(p);
      logInfo('runtime', `已删除装进去的插件 ${f}`);
    }
  }
  logInfo('runtime', `游戏文件已还原：${how}`);
  return { restored: true, how };
}

export interface MvmzActivatorOptions {
  gameDir: string;
  /** 桥插件源文件路径 */
  bridgePath: string;
  /** 桥的日志文件路径（GUI 游戏没有控制台，日志是唯一线索） */
  bridgeLogPath?: string;
}

export interface MvmzActivator extends RuntimeActivator {
  layout: MvmzLayout;
  /** 安装信息（还原要用） */
  install: MvmzInstallResult | null;
  /** 游戏进程退出时 resolve（用户关掉游戏 = 该收尾了） */
  whenExited(): Promise<number | null>;
  /** 立刻结束游戏进程（收尾时用） */
  kill(): void;
  /** 收尾：结束游戏进程 + 逐字节还原游戏文件（本引擎一定实现，故收紧为非可选） */
  deactivate(): Promise<void>;
}

export function createMvmzActivator(o: MvmzActivatorOptions): MvmzActivator {
  let child: ChildProcess | null = null;
  let exited: Promise<number | null> = Promise.resolve(null);
  let install: MvmzInstallResult | null = null;

  const kill = (): void => {
    if (child && child.exitCode === null && !child.killed) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // 尽力而为
      }
    }
  };

  return {
    get layout() {
      const l = install?.layout ?? detectMvmzLayout(o.gameDir);
      if (!l) throw new Error(`"${o.gameDir}" 不是 RPG Maker MV/MZ`);
      return l;
    },
    get install() {
      return install;
    },
    kill,
    whenExited() {
      return exited;
    },

    async activate(ctx: ActivationContext): Promise<RuntimeActivation> {
      install = installMvmzBridge(o.gameDir, o.bridgePath);
      const { layout } = install;

      const env: NodeJS.ProcessEnv = { ...process.env, BB_BUS_PORT: String(ctx.port) };
      if (o.bridgeLogPath) env.BB_BRIDGE_LOG = o.bridgeLogPath;

      child = spawn(layout.exePath, CHROMIUM_FLAGS, { cwd: o.gameDir, env, stdio: 'ignore' });
      const proc = child;
      exited = new Promise<number | null>((res) => {
        proc.on('exit', (code) => {
          logInfo('runtime', `游戏进程已退出（code=${code ?? 'null'}）`);
          res(code);
        });
        proc.on('error', (e) => {
          logError('runtime', `启动游戏失败：${e.message}`);
          res(null);
        });
      });

      logInfo('runtime', `已启动游戏 ${layout.engine}（pid=${child.pid}）：${layout.exePath}`);
      return { detail: `MV/MZ 运行时桥（pid=${child.pid}）` };
    },

    async deactivate(): Promise<void> {
      kill();
      try {
        uninstallMvmzBridge(o.gameDir, install?.backupPath);
        // 备份用完就删（里面只有一份 plugins.js）
        //
        // ★ 必须用 dirname 拿目录：join(p, '..') 得到的是 "…/bb-runtime-x/.."，
        //   直接喂给 rmSync(recursive) 会一路解析到临时根目录 —— 那是删别人的临时文件。
        if (install?.backupPath) {
          const dir = dirname(install.backupPath);
          if (dir.includes('bb-runtime-')) rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) {
        logWarn('runtime', `还原游戏文件失败：${(e as Error).message}`);
        throw e;
      }
    },
  };
}
