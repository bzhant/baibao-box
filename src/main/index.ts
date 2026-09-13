import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerBuiltinPlugins } from './bootstrap-plugins';
import { runCli } from './cli';
import { registerIpc, runningGameDir } from './ipc';
import { initPlatform, closePlatform, dbPath } from '@platform/init';

/**
 * Electron 主进程入口（shell 层）。
 * 只负责窗口/生命周期；业务逻辑都在各模块层，通过 IPC 暴露给渲染层。
 */

// GPU 降级开关：无显卡驱动 / 远程桌面 / CI 环境下 Chromium 的 GPU 进程会直接 FATAL 退出。
// 必须用 API 关闭硬件加速（只给 Chromium 传 --disable-gpu 不够），并把 GPU 收进主进程
// （否则独立 GPU 进程在受限环境里仍然崩 → "GPU process isn't usable. Goodbye."）。
// 必须在 app ready 之前调用。
//
// ★★ CLI 模式 / 自动化自检**无条件**关掉硬件加速（实测踩到）★★
//   之前只在显式传 `--disable-gpu` 时才关。开发期用的是
//   `npm run translate`（脚本里带了 --disable-gpu）所以一直没暴露；
//   但**打包成品**的用法是 `白的百宝箱.exe --game ...`（没有人会记得加那个参数）——
//   于是 CLI 跑长任务时 GPU 进程 FATAL 退出，整个命令直接崩掉。
//   一个纯文本批处理根本不需要 GPU，**CLI 模式就该自己搞定这件事**，
//   而不是要求用户记住一个内部参数。
//
//   `--smoke-test`（自动化自检）同理：它只跑在 CI / 无人值守环境，
//   而那正是最可能没有可用 GPU 的场景。
//
//   ★ 加新参数时记得同步 `NO_GPU_FLAGS`，否则新参数会被这里漏掉、
//     在无 GPU 的机器上以同样的方式崩掉。
const NO_GPU_FLAGS = [
  '--disable-gpu', // 兼容显式传入（脚本里仍会带）
  '--game', '--restore', '--repack-only', '--help', '-h', // CLI 模式
  '--runtime', '--runtime-restore', // 一键汉化（运行时）
  '--test-api', // 接口自检
  '--smoke-test', // 自动化自检
];
if (process.argv.some((a) => NO_GPU_FLAGS.includes(a))) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
}

/** 当前主窗口。IPC 需要它来做两件事：给系统对话框找父窗口、往渲染层推进度。 */
let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: '白的百宝箱',
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false, // better-sqlite3 等原生模块需要；后续收敛为 contextIsolation + 白名单 IPC
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // 外部链接一律交给系统浏览器，不在应用内开新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  // 冒烟测试钩子（CI / 自动化用）：渲染层加载完成后做平台层自检并退出，不需要外部 kill。
  //   electron . --smoke-test
  if (process.argv.includes('--smoke-test')) {
    win.webContents.once('did-finish-load', () => {
      // 平台层自检：验证原生 SQLite 在 Electron 运行时可用（ABI / FTS5 / trigram）
      try {
        const s = initPlatform();
        const p = s.probe();
        console.log(
          `[smoke] platform OK db=${dbPath()} sqlite=${p.sqliteVersion} fts=${p.ftsMatchOk} trigram=${p.trigramOk}`,
        );
        const round = s.upsert('__smoke__', [
          { engine: 'mvmz', path: 'smoke#/0', key: 'k', source: '自检文本', status: 'pending' },
        ]);
        const hit = s.search('__smoke__', '自检文本').length;
        console.log(`[smoke] store roundtrip inserted=${round.inserted} searchHit=${hit}`);
        s.removeGame('__smoke__');
        closePlatform();
        if (!p.ftsMatchOk) process.exitCode = 1;
      } catch (err) {
        console.error(`[smoke] platform FAILED: ${(err as Error).message}`);
        process.exitCode = 1;
      }
      console.log('[smoke] renderer loaded OK');
      app.quit();
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      console.error(`[smoke] renderer failed: ${code} ${desc}`);
      process.exitCode = 1;
      app.quit();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[smoke] renderer gone: ${details.reason}`);
      process.exitCode = 1;
      app.quit();
    });
  }

  return win;
}

/**
 * CLI 模式：带这些参数时**不开窗**，跑完即退（headless）。
 *
 * ★ 这里必须把"用户可能只是想看帮助"也算进去：`--help` 单独用时，
 *   如果没被算作 CLI 模式，用户会看到**一个窗口弹出来**而不是帮助文本 ——
 *   对一个"用户敲了 --help"的场景来说，这是最糟的回应。
 *
 * ★ 加新 CLI 参数时**记得同步这里**，否则那个参数会被当成 GUI 启动参数、
 *   静默地被忽略（程序照常开窗，用户以为参数没生效）。
 */
const CLI_FLAGS = ['--game', '--restore', '--repack-only', '--help', '-h', '--runtime', '--runtime-restore', '--test-api'];
const isCliMode = process.argv.some((a) => CLI_FLAGS.includes(a));

// 关硬件加速的判定已在上方 `NO_GPU_FLAGS` 处统一处理（含 CLI / --smoke-test / --disable-gpu），
// 这里不再重复；加新 CLI 参数时**两处都要同步**。

app.whenReady().then(async () => {
  registerBuiltinPlugins(); // 注册内置引擎适配器 / 翻译 Provider（幂等）

  if (isCliMode) {
    const code = await runCli(process.argv.slice(1));
    app.exit(code);
    return;
  }

  // ★ IPC 只注册一次。`ipcMain.handle` 对同一通道重复注册会直接抛异常，
  //   所以放在这里（而不是 createMainWindow 里）—— 窗口可能被重建多次
  //   （macOS 点 dock 图标、或以后做"多窗口"时），但 IPC 只该注册一次。
  registerIpc(() => mainWindow);

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 退出前关闭文本库，确保 WAL 落盘
app.on('will-quit', () => {
  closePlatform();
});

// 翻译中途退出是很糟的体验：游戏文件可能只写了一半。
// 这里至少把事实说清楚（打日志），而不是静默退出。
app.on('before-quit', () => {
  const g = runningGameDir();
  if (g) {
    console.warn(
      `[bb] 应用在翻译进行中退出（游戏：${g}）。\n` +
      `     已写入的部分不会自动回滚 —— 建议下次启动后用界面的"一键还原"回到翻译前状态。`,
    );
  }
});
