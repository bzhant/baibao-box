import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { registerBuiltinPlugins } from './bootstrap-plugins';
import { registry } from '@platform/plugin-registry';
import { configStatus, hasApiKey as hasApiKeyCfg, setApiKey, updateConfig, type AppConfig } from '@platform/config';
import { clearLogs, listLogs, logInfo, logScopes, type LogLevel } from '@platform/logbus';
import { initPlatform, dbPath } from '@platform/init';
import {
  detectGame,
  restoreGame,
  runTranslate,
  type TranslateOptions,
} from './translate-service';
import type { PipelineProgress } from '../pipeline/translate-pipeline';
import {
  lastRuntimeSummary,
  runtimeStatus,
  startRuntime,
  stopRuntime,
} from './runtime-service';
import { pickProvider } from './translate-service';
import {
  previewRepack,
  repackGame,
} from './translate-service';
import {
  listEntries,
  saveEntry,
  bulkReplace,
  exportEntries,
  importEntries,
  type WorkbenchQuery,
  type BulkReplaceOptions,
} from './workbench-service';

/**
 * IPC 层 —— 渲染进程能做的事的**白名单**。
 *
 * 设计原则：
 *   1. **在白名单里，绝不放 `ipcRenderer` 出去**（preload 只暴露具名方法）。
 *   2. 每个通道**只做一件事**，参数在这里校验；渲染层拿不到文件系统/子进程能力。
 *   3. 所有可能抛出/耗时的操作都返回统一结构 `{ ok, data?, error? }` ——
 *      渲染层不需要写 try/catch，也不会因为一个未捕获的 reject 把界面卡死。
 *   4. 长任务（翻译）**不在 invoke 里等结果**：立刻返回"已开始"，
 *      进度与最终结果通过单向事件推到渲染层。否则渲染层 await 一个几十分钟的
 *      Promise，既没有进度也没法取消。
 */

export const IPC = {
  pickGameDir: 'bb:pick-game-dir',
  detect: 'bb:detect',
  translate: 'bb:translate',
  restore: 'bb:restore',
  reveal: 'bb:reveal',
  env: 'bb:env',
  engines: 'bb:engines',
  // ── 配置与日志 ──
  cfgStatus: 'bb:cfg-status',
  cfgUpdate: 'bb:cfg-update',
  cfgSetKey: 'bb:cfg-set-key',
  logs: 'bb:logs',
  logsClear: 'bb:logs-clear',
  // ── 一键汉化（运行时）──
  adoptPath: 'bb:adopt-path',
  runtimeStart: 'bb:runtime-start',
  runtimeStop: 'bb:runtime-stop',
  runtimeStatus: 'bb:runtime-status',
  // ── 人工修订工作台（工作台能力）──
  wbList: 'bb:wb-list',
  wbSave: 'bb:wb-save',
  wbBulk: 'bb:wb-bulk',
  wbExport: 'bb:wb-export',
  wbImport: 'bb:wb-import',
  wbPickExport: 'bb:wb-pick-export',
  wbPickImport: 'bb:wb-pick-import',
  wbRepackPreview: 'bb:wb-repack-preview',
  wbRepack: 'bb:wb-repack',
  // 主进程 → 渲染进程（单向）
  progress: 'bb:progress',
  finished: 'bb:finished',
} as const;

/** 统一返回结构：渲染层只判断 ok，不用 try/catch */
export interface IpcOk<T> { ok: true; data: T }
export interface IpcErr { ok: false; error: string }
export type IpcResult<T> = IpcOk<T> | IpcErr;

function ok<T>(data: T): IpcOk<T> {
  return { ok: true, data };
}
function err(e: unknown): IpcErr {
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

/** 会话级状态：同一时刻只允许一个翻译任务（避免两个任务同时回写同一游戏） */
let running: { gameDir: string; startedAt: number } | null = null;

export function isTranslating(): boolean {
  return running !== null;
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  registerBuiltinPlugins(); // 幂等

  // ── 选目录：用系统原生对话框，而不是让用户手打路径 ──
  ipcMain.handle(IPC.pickGameDir, async (): Promise<IpcResult<string | null>> => {
    try {
      const win = getWindow();
      const r = win
        ? await dialog.showOpenDialog(win, {
            title: '选择游戏根目录（含 data/ 或 www/ 的那一层）',
            properties: ['openDirectory'],
          })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths[0]) return ok(null);
      return ok(r.filePaths[0]);
    } catch (e) {
      return err(e);
    }
  });

  // ── 引擎识别 ──
  ipcMain.handle(IPC.detect, async (_e, gameDir: unknown): Promise<IpcResult<Awaited<ReturnType<typeof detectGame>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      const dir = resolve(gameDir);
      if (!existsSync(dir)) return err(`目录不存在：${dir}`);
      return ok(await detectGame(dir));
    } catch (e) {
      return err(e);
    }
  });

  // ── 开始汉化（立刻返回，进度与结果走事件）──
  ipcMain.handle(IPC.translate, async (_e, raw: unknown): Promise<IpcResult<{ started: true }>> => {
    try {
      const opts = (raw ?? {}) as TranslateOptions;
      if (typeof opts.gameDir !== 'string' || !opts.gameDir.trim()) return err('缺少游戏目录');
      if (running) {
        return err(`已有任务在执行（${running.gameDir}）。请等它结束，或先还原。`);
      }
      const gameDir = resolve(opts.gameDir);
      const win = getWindow();
      running = { gameDir, startedAt: Date.now() };

      // 不 await：让 invoke 立刻返回，渲染层马上能进"进行中"状态并收到进度
      void (async () => {
        try {
          const out = await runTranslate(
            { ...opts, gameDir },
            (p: PipelineProgress) => {
              win?.webContents.send(IPC.progress, p);
            },
          );
          win?.webContents.send(IPC.finished, { ok: true, data: out });
        } catch (e) {
          win?.webContents.send(IPC.finished, err(e));
        } finally {
          running = null;
        }
      })();

      return ok({ started: true });
    } catch (e) {
      return err(e);
    }
  });

  // ── 一键还原（工程红线：可逆）──
  ipcMain.handle(IPC.restore, async (_e, gameDir: unknown): Promise<IpcResult<Awaited<ReturnType<typeof restoreGame>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (running) return err('正在翻译中，请等它结束后再还原。');
      return ok(await restoreGame(gameDir));
    } catch (e) {
      return err(e);
    }
  });

  // ── 配置 ────────────────────────────────────────────────────────────
  //
  // ★ 密钥**只进不出**：`cfgStatus` 只回答"有没有配""是否加密"，永不返回密钥本身。
  //   否则渲染层被注入脚本就等于密钥泄露 —— 而 contextIsolation 的价值也就没了。
  ipcMain.handle(IPC.cfgStatus, async (): Promise<IpcResult<unknown>> => {
    try {
      return ok(configStatus());
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.cfgUpdate, async (_e, patch: unknown): Promise<IpcResult<unknown>> => {
    try {
      const p = (patch ?? {}) as Partial<AppConfig>;
      // 只接受已知字段，别让渲染层往配置里塞任意东西
      const allowed: Array<keyof AppConfig> = [
        'openaiBaseUrl', 'openaiModel', 'defaultFrom', 'defaultTo',
        'batchSize', 'concurrency', 'backupBeforeRepack',
      ];
      const clean: Partial<AppConfig> = {};
      for (const k of allowed) {
        if (k in p) (clean as Record<string, unknown>)[k] = (p as Record<string, unknown>)[k];
      }
      return ok(updateConfig(clean));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.cfgSetKey, async (_e, key: unknown): Promise<IpcResult<{ encrypted: boolean }>> => {
    try {
      if (typeof key !== 'string') return err('密钥必须是字符串');
      const r = setApiKey(key.trim());
      logInfo('config', key.trim() ? `已保存 API Key（${r.encrypted ? '已加密' : '⚠ 明文'}）` : '已清除 API Key');
      return ok(r);
    } catch (e) {
      return err(e);
    }
  });

  // ── 日志 ────────────────────────────────────────────────────────────
  //
  // 打包后的应用**没有终端** —— 这些日志是用户唯一能看到"刚才发生了什么"的地方。
  ipcMain.handle(IPC.logs, async (_e, opts: unknown): Promise<IpcResult<unknown>> => {
    try {
      const o = (opts ?? {}) as { limit?: number; level?: LogLevel; scope?: string };
      return ok({ items: listLogs(o), scopes: logScopes() });
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.logsClear, async (): Promise<IpcResult<true>> => {
    try {
      clearLogs();
      return ok(true);
    } catch (e) {
      return err(e);
    }
  });

  // ── 引擎清单（声明式）────────────────────────────────────────────────────
  //
  // 界面靠它自适应：各引擎的"该选哪层目录 / 常见源语言 / 字体机制 / 已知坑"
  // 全在数据里。**界面不含 `if (engineId === 'mvmz')` 这类分支** ——
  // 加一个引擎只需加一份 manifest（声明式配置的要求）。
  ipcMain.handle(IPC.engines, async (): Promise<IpcResult<unknown>> => {
    try {
      return ok(registry.listManifests());
    } catch (e) {
      return err(e);
    }
  });

  // ── 人工修订工作台 ──────────────────────────────────────────────────────
  //
  // 这一组都是"改数据"的操作，与翻译流水线**共用同一把锁**：
  // 翻译进行中不允许改译文 —— 否则流水线正在回写、用户同时在改，两边都不一致。

  ipcMain.handle(IPC.wbList, async (_e, gameDir: unknown, q: unknown): Promise<IpcResult<Awaited<ReturnType<typeof listEntries>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      return ok(await listEntries(gameDir, (q ?? {}) as WorkbenchQuery));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbSave, async (_e, gameDir: unknown, path: unknown, key: unknown, translated: unknown, status: unknown): Promise<IpcResult<{ changed: boolean }>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (typeof path !== 'string' || typeof key !== 'string' || !path || !key) return err('定位信息不完整');
      if (running) return err('正在翻译中，请等它结束后再编辑。');
      const t = translated === null || translated === undefined ? null : String(translated);
      return ok(await saveEntry(gameDir, path, key, t, status as never));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbBulk, async (_e, gameDir: unknown, opt: unknown): Promise<IpcResult<Awaited<ReturnType<typeof bulkReplace>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (running) return err('正在翻译中，请等它结束后再做批量替换。');
      return ok(await bulkReplace(gameDir, (opt ?? {}) as BulkReplaceOptions));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbPickExport, async (): Promise<IpcResult<string | null>> => {
    try {
      const win = getWindow();
      const r = win
        ? await dialog.showSaveDialog(win, {
            title: '导出译文包', defaultPath: 'baibao-export.json',
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showSaveDialog({ defaultPath: 'baibao-export.json' });
      return ok(r.canceled || !r.filePath ? null : r.filePath);
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbExport, async (_e, gameDir: unknown, outFile: unknown): Promise<IpcResult<Awaited<ReturnType<typeof exportEntries>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (typeof outFile !== 'string' || !outFile.trim()) return err('导出路径为空');
      return ok(await exportEntries(gameDir, outFile));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbPickImport, async (): Promise<IpcResult<string | null>> => {
    try {
      const win = getWindow();
      const r = win
        ? await dialog.showOpenDialog(win, {
            title: '选择译文包', properties: ['openFile'],
            filters: [{ name: 'JSON', extensions: ['json'] }],
          })
        : await dialog.showOpenDialog({ properties: ['openFile'] });
      return ok(r.canceled || !r.filePaths[0] ? null : r.filePaths[0]);
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbImport, async (_e, gameDir: unknown, inFile: unknown): Promise<IpcResult<Awaited<ReturnType<typeof importEntries>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (typeof inFile !== 'string' || !inFile.trim()) return err('导入路径为空');
      if (running) return err('正在翻译中，请等它结束后再导入。');
      return ok(await importEntries(gameDir, inFile));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbRepackPreview, async (_e, gameDir: unknown): Promise<IpcResult<Awaited<ReturnType<typeof previewRepack>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      return ok(await previewRepack(gameDir));
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle(IPC.wbRepack, async (_e, gameDir: unknown): Promise<IpcResult<Awaited<ReturnType<typeof repackGame>>>> => {
    try {
      if (typeof gameDir !== 'string' || !gameDir.trim()) return err('游戏目录为空');
      if (running) return err('正在翻译中，请等它结束后再回写。');
      const win = getWindow();
      return ok(await repackGame(gameDir, (p2) => win?.webContents.send(IPC.progress, p2)));
    } catch (e) {
      return err(e);
    }
  });

  // ── 在资源管理器里打开（备份目录、文本库所在目录）──
  /**
   * 把"拖进来的路径"折算成**游戏目录**。
   *
   * 用户可能拖 `Game.exe`（要的是它所在目录），也可能直接拖游戏文件夹 —— 两种都得认。
   * 判断必须在主进程做：渲染层拿不到可靠的文件类型信息（`File` 对象对目录和文件长得一样）。
   */
  ipcMain.handle(IPC.adoptPath, async (_e, p: unknown): Promise<IpcResult<string>> => {
    if (typeof p !== 'string' || p.length === 0) return { ok: false, error: '路径为空' };
    try {
      const st = statSync(p);
      return { ok: true, data: st.isDirectory() ? p : dirname(p) };
    } catch (e) {
      return { ok: false, error: `读不到这个路径：${(e as Error).message}` };
    }
  });

  // ── 一键汉化（运行时）────────────────────────────────────────────
  //
  // 与"静态汉化"（IPC.translate）的分工：
  //   静态 —— 抽取 → 翻译 → 回写游戏数据文件；持久、离线可玩，但改游戏文件。
  //   运行时 —— 启动游戏时把桥装进去，边玩边翻；**不改游戏数据文件**，
  //             对加密游戏同样有效，退出时逐字节还原。
  // 翻译都走同一套 Provider（界面里配的 API 密钥/模型/baseUrl）。
  ipcMain.handle(IPC.runtimeStart, async (_e, gameDir: unknown): Promise<IpcResult<unknown>> => {
    if (typeof gameDir !== 'string' || gameDir.length === 0) {
      return { ok: false, error: '需要游戏目录' };
    }
    try {
      const { provider, autoStub } = pickProvider(undefined);
      const r = await startRuntime({
        gameDir,
        provider,
        providerName: provider.displayName,
        autoStub,
      });
      logInfo('ipc', `一键汉化已启动：${r.engine} · ${r.providerName}`);
      return { ok: true, data: r };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.runtimeStop, async (): Promise<IpcResult<unknown>> => {
    try {
      await stopRuntime();
      return { ok: true, data: runtimeStatus() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle(IPC.runtimeStatus, async (): Promise<IpcResult<unknown>> => {
    return { ok: true, data: { ...runtimeStatus(), last: lastRuntimeSummary() } };
  });

  ipcMain.handle(IPC.reveal, async (_e, p: unknown): Promise<IpcResult<true>> => {
    try {
      if (typeof p !== 'string' || !p.trim()) return err('路径为空');
      const target = existsSync(p) ? p : dirname(p);
      if (!existsSync(target)) return err(`路径不存在：${target}`);
      await shell.openPath(target);
      return ok(true);
    } catch (e) {
      return err(e);
    }
  });

  // ── 环境信息：文本库位置、是否有 API Key、当前是否在翻译中 ──
  ipcMain.handle(IPC.env, async (): Promise<IpcResult<{
    dbPath: string;
    hasApiKey: boolean;
    translating: boolean;
  }>> => {
    try {
      // 这里顺手把平台层初始化一次，界面上就能显示真实的库路径（而不是"待初始化"）
      initPlatform();
      return ok({
        dbPath: dbPath(),
        hasApiKey: hasApiKeyCfg() || !!process.env['BAIBAO_OPENAI_API_KEY'],
        translating: isTranslating(),
      });
    } catch (e) {
      return err(e);
    }
  });
}

/** 供窗口关闭前查询：避免在翻译中途退出应用 */
export function runningGameDir(): string | null {
  return running?.gameDir ?? null;
}

export { join };
