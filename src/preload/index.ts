import { contextBridge, ipcRenderer } from 'electron';

/**
 * 预加载脚本：以最小、可控的方式把能力暴露给渲染层。
 *
 * ★ 三条硬规矩：
 *   1. **绝不把 `ipcRenderer` 整个暴露出去**（否则渲染层等于拿到了任意通道的调用权）。
 *      这里只暴露具名方法 —— 相当于一份"白名单"，通道名写死在本文件里。
 *   2. 通道名**不在渲染层出现**。渲染层只认 `window.baibao.startTranslate(...)` 这样的
 *      语义化 API，将来换通信方式（Worker / 本地 HTTP）时渲染层一行都不用改。
 *   3. 事件订阅返回"取消订阅函数"，让 React 的 useEffect 能干净卸载 ——
 *      否则热更新时监听会叠加，进度条来回跳且找不到原因。
 */

/** 与主进程 `IPC` 常量保持一致（此处刻意重复写字面量：preload 不应 import 主进程模块） */
const CH = {
  pickGameDir: 'bb:pick-game-dir',
  detect: 'bb:detect',
  translate: 'bb:translate',
  translateCancel: 'bb:translate-cancel',
  restore: 'bb:restore',
  reveal: 'bb:reveal',
  env: 'bb:env',
  engines: 'bb:engines',
  cfgStatus: 'bb:cfg-status',
  cfgUpdate: 'bb:cfg-update',
  cfgSetKey: 'bb:cfg-set-key',
  cfgProfileSave: 'bb:cfg-profile-save',
  cfgProfileDelete: 'bb:cfg-profile-delete',
  cfgProfileActivate: 'bb:cfg-profile-activate',
  cfgProfileTest: 'bb:cfg-profile-test',
  logs: 'bb:logs',
  logsClear: 'bb:logs-clear',
  wbList: 'bb:wb-list',
  wbSave: 'bb:wb-save',
  wbBulk: 'bb:wb-bulk',
  wbExport: 'bb:wb-export',
  wbImport: 'bb:wb-import',
  wbPickExport: 'bb:wb-pick-export',
  wbPickImport: 'bb:wb-pick-import',
  adoptPath: 'bb:adopt-path',
  runtimeStart: 'bb:runtime-start',
  runtimeStop: 'bb:runtime-stop',
  runtimeStatus: 'bb:runtime-status',
  floatingOpen: 'bb:floating-open',
  floatingClose: 'bb:floating-close',
  floatingStatus: 'bb:floating-status',
  floatingSetExpanded: 'bb:floating-set-expanded',
  floatingSetPosition: 'bb:floating-set-position',
  showMainWindow: 'bb:show-main-window',
  wbRepackPreview: 'bb:wb-repack-preview',
  wbRepack: 'bb:wb-repack',
  progress: 'bb:progress',
  finished: 'bb:finished',
} as const;

type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** 进度事件的形状（与 pipeline 的 PipelineProgress 对应） */
export interface ProgressEvent {
  phase: 'extract' | 'store' | 'tm' | 'translate' | 'repack' | 'font' | 'done';
  current: number;
  total: number;
  message?: string;
}

export interface EngineInfo {
  ok: boolean;
  engineId?: string;
  engineName?: string;
  confidence?: number;
  notes: string[];
  encrypted: boolean;
  candidates: string[];
  message?: string;
  gameId: string;
}

const api = {
  /** 运行环境信息（界面上显示版本、库路径） */
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },

  /** 弹系统目录选择框；用户取消返回 null */
  pickGameDir: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(CH.pickGameDir),

  /** 引擎识别（选完目录立刻调，让用户马上知道"选对没有"） */
  detect: (gameDir: string): Promise<IpcResult<EngineInfo>> =>
    ipcRenderer.invoke(CH.detect, gameDir),

  /**
   * 开始汉化。**立刻返回**，之后靠 onProgress / onFinished 拿进度与结果。
   * 不 await 到最后的原因：几十分钟的任务不该把调用方挂住，那样也拿不到进度。
   */
  startTranslate: (opts: {
    gameDir: string;
    from?: string;
    to?: string;
    limit?: number;
    repack?: boolean;
    injectFont?: boolean;
    providerId?: string;
  }): Promise<IpcResult<{ started: true }>> => ipcRenderer.invoke(CH.translate, opts),
  cancelTranslate: (): Promise<IpcResult<{ cancelled: boolean }>> =>
    ipcRenderer.invoke(CH.translateCancel),

  /** 一键还原（回到翻译前） */
  restore: (gameDir: string): Promise<IpcResult<{
    patches: number;
    restored: number;
    errors: string[];
    nothingToDo: boolean;
  }>> => ipcRenderer.invoke(CH.restore, gameDir),

  /** 在资源管理器里定位文件/目录 */
  reveal: (path: string): Promise<IpcResult<true>> => ipcRenderer.invoke(CH.reveal, path),
  /** 把拖进来的路径折算成游戏目录（拖 Game.exe 或拖文件夹都认） */
  adoptPath: (p: string): Promise<IpcResult<string>> => ipcRenderer.invoke(CH.adoptPath, p),

  /**
   * **一键汉化**：把运行时桥装进游戏、启动它，宿主边玩边翻。
   * 返回时游戏已经在跑；关闭游戏即自动还原游戏文件。
   */
  runtimeStart: (gameDir: string): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.runtimeStart, gameDir),
  /** 收尾：结束游戏并逐字节还原游戏文件 */
  runtimeStop: (): Promise<IpcResult<unknown>> => ipcRenderer.invoke(CH.runtimeStop),
  /** 当前运行时会话状态（界面轮询它显示进度） */
  runtimeStatus: (): Promise<IpcResult<unknown>> => ipcRenderer.invoke(CH.runtimeStatus),
  /** 开启 / 关闭悬浮窗（小型快速操作面板） */
  floatingOpen: (): Promise<IpcResult<{ open: boolean }>> => ipcRenderer.invoke(CH.floatingOpen),
  floatingClose: (): Promise<IpcResult<{ open: boolean }>> => ipcRenderer.invoke(CH.floatingClose),
  floatingStatus: (): Promise<IpcResult<{ open: boolean; expanded: boolean }>> =>
    ipcRenderer.invoke(CH.floatingStatus),
  floatingSetExpanded: (expanded: boolean): Promise<IpcResult<{ open: boolean; expanded: boolean }>> =>
    ipcRenderer.invoke(CH.floatingSetExpanded, expanded),
  floatingSetPosition: (x: number, y: number): Promise<IpcResult<{ moved: boolean }>> =>
    ipcRenderer.invoke(CH.floatingSetPosition, x, y),
  showMainWindow: (): Promise<IpcResult<{ shown: true }>> => ipcRenderer.invoke(CH.showMainWindow),

  /** 环境信息 */
  env: (): Promise<IpcResult<{ dbPath: string; hasApiKey: boolean; translating: boolean }>> =>
    ipcRenderer.invoke(CH.env),

  // ── 配置。密钥**只进不出**：这里没有"读密钥"的方法，只有"设置" ──

  /** 配置状态（含"有没有配密钥""是否加密"），**不含密钥本身** */
  cfgStatus: (): Promise<IpcResult<unknown>> => ipcRenderer.invoke(CH.cfgStatus),

  /** 更新偏好项（baseUrl / model / 默认语言 / 批大小 / 并发…） */
  cfgUpdate: (patch: Record<string, unknown>): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.cfgUpdate, patch),

  /** 设置或清除 API Key（空串 = 清除） */
  /** 给**指定方案**写密钥（只进不出：写进去之后界面读不回来） */
  cfgSetKey: (profileId: string, key: string): Promise<IpcResult<{ encrypted: boolean }>> =>
    ipcRenderer.invoke(CH.cfgSetKey, profileId, key),
  /** 新增/修改一套接口方案 */
  cfgProfileSave: (p: Record<string, unknown>): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.cfgProfileSave, p),
  /** 删除一套方案（只剩一套时会拒绝） */
  cfgProfileDelete: (id: string): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.cfgProfileDelete, id),
  /** 切换当前启用的方案 */
  cfgProfileActivate: (id: string): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.cfgProfileActivate, id),
  /** 测试一套方案：真发一句去测（不是"看有没有填密钥"） */
  cfgProfileTest: (id: string): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.cfgProfileTest, id),

  // ── 日志（打包后的应用没有终端，这些是用户唯一能看到的线索）──

  /** 读最近日志；scope 用于筛选类别 */
  logs: (opts?: { limit?: number; level?: string; scope?: string }): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.logs, opts ?? {}),

  logsClear: (): Promise<IpcResult<true>> => ipcRenderer.invoke(CH.logsClear),

  /** 引擎清单（声明式配置）：界面据此自适应，不写死任何引擎名 */
  engines: (): Promise<IpcResult<unknown>> => ipcRenderer.invoke(CH.engines),

  // ── 人工修订工作台（工作台）──────────────────────────────────────

  /** 取一页条目（含统计与"文件树"计数） */
  wbList: (gameDir: string, q: Record<string, unknown>): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbList, gameDir, q),

  /** 单条编辑：译文传 null = 清空回未译 */
  wbSave: (
    gameDir: string, path: string, key: string, translated: string | null, status?: string,
    scope?: { from?: string; to?: string },
  ): Promise<IpcResult<{ changed: boolean }>> =>
    ipcRenderer.invoke(CH.wbSave, gameDir, path, key, translated, status, scope),

  /** 批量替换（dryRun=true 只预演并给样例） */
  wbBulk: (gameDir: string, opt: Record<string, unknown>): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbBulk, gameDir, opt),

  wbPickExport: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(CH.wbPickExport),
  wbExport: (gameDir: string, outFile: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbExport, gameDir, outFile, scope),
  wbPickImport: (): Promise<IpcResult<string | null>> => ipcRenderer.invoke(CH.wbPickImport),
  wbImport: (gameDir: string, inFile: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbImport, gameDir, inFile, scope),

  /** 回写前的预览：看清将要写什么（只统计 translated/reviewed，绝不写 pending/conflict） */
  wbRepackPreview: (gameDir: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbRepackPreview, gameDir, scope),

  /** 只回写：把库里的译文落到游戏文件（适配器内部会自动备份） */
  wbRepack: (gameDir: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>> =>
    ipcRenderer.invoke(CH.wbRepack, gameDir, scope),

  /** 订阅进度；返回取消订阅函数 */
  onProgress: (cb: (p: ProgressEvent) => void): (() => void) => {
    const h = (_e: unknown, p: ProgressEvent): void => cb(p);
    ipcRenderer.on(CH.progress, h);
    return () => ipcRenderer.removeListener(CH.progress, h);
  },

  /** 订阅"翻译结束"（成功与失败都走这里） */
  onFinished: (cb: (r: IpcResult<unknown>) => void): (() => void) => {
    const h = (_e: unknown, r: IpcResult<unknown>): void => cb(r);
    ipcRenderer.on(CH.finished, h);
    return () => ipcRenderer.removeListener(CH.finished, h);
  },
};

export type BaiBaoApi = typeof api;

contextBridge.exposeInMainWorld('baibao', api);
