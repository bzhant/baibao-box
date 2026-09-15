import React from 'react';
import Workbench from './Workbench';
import Settings from './Settings';
import Logs from './Logs';
import FloatingPanel from './FloatingPanel';

/**
 * 白的百宝箱 —— 主界面
 *
 * 目标（PLAN §1 三层目标的体验层）：**导入 → 选目标语言 → 开始，≤ 3 次点击**。
 *
 * 这一版覆盖的是"主线闭环"：
 *   选游戏目录 → 立刻识别引擎（选错目录马上知道）
 *   → 开始汉化（阶段化进度）→ 看结果 → 一键还原
 *
 * 为什么相机先做这条线：编排逻辑已经在 CLI 里被**真游戏验证过**
 * （拆 4064/7487 条、字体注入、逐字节还原）。把它接出来，用户立刻能用；
 * 而"人工修订工作台"（工作台）建在同一条数据层上，放第二步。
 */

// ── 渲染层看到的类型（与 preload 的 API 对应） ──────────────────────────────

interface ProgressEvent {
  phase: 'extract' | 'store' | 'tm' | 'translate' | 'repack' | 'font' | 'done';
  current: number;
  total: number;
  message?: string;
}

interface EngineInfo {
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

interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * 引擎声明式配置（来自 registry.listManifests）。
 *
 * ★ 界面**只读这份数据**，不含任何 `if (engineId === 'mvmz')` 分支 ——
 *   加一个新引擎 = 它自己带一份 manifest，界面一行都不用改。
 */
interface CfgView {
  hasApiKey: boolean;
  secretEncrypted: boolean;
  path: string;
  config: {
    activeProfileId: string;
    defaultFrom: string; defaultTo: string;
    batchSize: number; concurrency: number; backupBeforeRepack: boolean;
  };
  /** 接口方案（多套） */
  profiles: Array<{
    id: string; name: string; baseUrl: string; model: string; preset: string;
    hasKey: boolean; encrypted: boolean; isActive: boolean;
  }>;
  activeProfile: { id: string; name: string; baseUrl: string; model: string };
}

interface EngineManifestView {
  id: string;
  displayName: string;
  rootHint: string;
  sourceLanguages: Array<{ id: string; label: string }>;
  fontOptionNote?: string;
  caveats: string[];
  capabilities: Record<string, boolean>;
}

interface Report {
  engine: string;
  extracted: number;
  alreadyApplied: number;
  upsert: { inserted: number; invalidated: number };
  candidates: number;
  fromCache: number;
  sentToProvider: number;
  translated: number;
  conflicts: number;
  failed: number;
  repack?: { written: number; unchanged: number; skipped: number; backupDir?: string };
  font?: { detail: string; notes: string[] };
  durationMs: number;
  errors: string[];
  cancelled?: boolean;
}

interface Outcome {
  report: Report;
  engineId: string;
  engineName: string;
  providerName: string;
  gameId: string;
  dbPath: string;
  autoStub: boolean;
  durationMs: number;
}

interface RestoreOutcome {
  patches: number;
  restored: number;
  errors: string[];
  nothingToDo: boolean;
}

interface BaiBaoApi {
  platform: string;
  versions: Record<string, string>;
  pickGameDir(): Promise<IpcResult<string | null>>;
  detect(d: string): Promise<IpcResult<EngineInfo>>;
  startTranslate(o: Record<string, unknown>): Promise<IpcResult<{ started: true }>>;
  cancelTranslate(): Promise<IpcResult<{ cancelled: boolean }>>;
  /** 把拖进来的路径折算成游戏目录（拖 Game.exe 或拖文件夹都认） */
  adoptPath(p: string): Promise<IpcResult<string>>;
  /** 给指定方案写密钥（只进不出） */
  cfgSetKey(profileId: string, key: string): Promise<IpcResult<{ encrypted: boolean }>>;
  /** 接口方案的增删改查 */
  cfgProfileSave(p: Record<string, unknown>): Promise<IpcResult<unknown>>;
  cfgProfileDelete(id: string): Promise<IpcResult<unknown>>;
  cfgProfileActivate(id: string): Promise<IpcResult<unknown>>;
  cfgProfileTest(id: string): Promise<IpcResult<unknown>>;
  runtimeStart(gameDir: string): Promise<IpcResult<unknown>>;
  /** 收尾：结束游戏 + 逐字节还原游戏文件 */
  runtimeStop(): Promise<IpcResult<unknown>>;
  /** 运行时会话状态（界面轮询显示进度） */
  runtimeStatus(): Promise<IpcResult<unknown>>;
  floatingOpen(): Promise<IpcResult<{ open: boolean }>>;
  floatingClose(): Promise<IpcResult<{ open: boolean }>>;
  floatingStatus(): Promise<IpcResult<{ open: boolean; expanded: boolean }>>;
  floatingSetExpanded(expanded: boolean): Promise<IpcResult<{ open: boolean; expanded: boolean }>>;
  floatingSetPosition(x: number, y: number): Promise<IpcResult<{ moved: boolean }>>;
  showMainWindow(): Promise<IpcResult<{ shown: true }>>;
  restore(d: string): Promise<IpcResult<RestoreOutcome>>;
  reveal(p: string): Promise<IpcResult<true>>;
  env(): Promise<IpcResult<{ dbPath: string; hasApiKey: boolean; translating: boolean }>>;
  onProgress(cb: (p: ProgressEvent) => void): () => void;
  onFinished(cb: (r: IpcResult<Outcome>) => void): () => void;
  // 人工修订工作台（工作台）
  wbList(gameDir: string, q: Record<string, unknown>): Promise<IpcResult<unknown>>;
  wbSave(
    gameDir: string, path: string, key: string, translated: string | null, status?: string,
    scope?: { from?: string; to?: string },
  ): Promise<IpcResult<{ changed: boolean }>>;
  wbBulk(gameDir: string, opt: Record<string, unknown>): Promise<IpcResult<unknown>>;
  wbPickExport(): Promise<IpcResult<string | null>>;
  wbExport(gameDir: string, outFile: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>>;
  wbPickImport(): Promise<IpcResult<string | null>>;
  wbImport(gameDir: string, inFile: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>>;
  wbRepackPreview(gameDir: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>>;
  wbRepack(gameDir: string, scope?: { from?: string; to?: string }): Promise<IpcResult<unknown>>;
  engines(): Promise<IpcResult<unknown>>;
  cfgStatus(): Promise<IpcResult<unknown>>;
  cfgUpdate(patch: Record<string, unknown>): Promise<IpcResult<unknown>>;
  logs(opts?: { limit?: number; level?: string; scope?: string }): Promise<IpcResult<unknown>>;
  logsClear(): Promise<IpcResult<true>>;
}

declare global {
  interface Window {
    baibao: BaiBaoApi;
  }
}

// ── 阶段名：给用户看的是人话，不是 'extract' ─────────────────────────────────

const PHASE_LABEL: Record<ProgressEvent['phase'], string> = {
  extract: '抽取文本',
  store: '写入文本库',
  tm: '查翻译记忆',
  translate: '调用翻译',
  repack: '回写游戏',
  font: '注入字体',
  done: '完成',
};

const PHASE_ORDER: ProgressEvent['phase'][] = ['extract', 'store', 'tm', 'translate', 'repack', 'font'];
const LAST_GAME_DIR_KEY = 'baibao:floating:last-game-dir';

function readSharedGameDir(): string {
  try {
    return window.localStorage.getItem(LAST_GAME_DIR_KEY) ?? '';
  } catch {
    return '';
  }
}

// ── 样式（沿用既有的深色基调，只补本页需要的部分） ───────────────────────

const css = `
  * { box-sizing: border-box; scrollbar-width:none; }
  *::-webkit-scrollbar { width:0; height:0; display:none; }
  html, body, #root { width:100%; height:100%; min-width:0; }
  body { margin:0; font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
         background:#101216; color:#e7ebf0; -webkit-font-smoothing:antialiased; overflow:hidden; }
  #root { display:flex; flex-direction:column; }
  .wrap { width:100%; max-width:none; min-width:0; min-height:0; flex:1; display:flex;
          flex-direction:column; overflow:hidden; margin:0; background:#101216; }
  /* 拖拽时的视觉反馈：不提示的话用户根本不知道"能不能往里拖" */
  .wrap.dragging .workspace { box-shadow:inset 0 0 0 2px #4a7ede; }
  .wrap.dragging .appHeaderSub { color:#9fc0ff; }

  .kicker { font-size:11px; letter-spacing:.18em; color:#6b7686; font-weight:700; text-transform:uppercase; }
  h1 { font-size:18px; margin:0; letter-spacing:0; }
  .sub { color:#98a2b0; font-size:13.5px; margin-bottom:26px; }
  .appHeader { flex:0 0 auto; padding:12px clamp(20px, 2.8vw, 44px) 0; background:#12151a;
               box-shadow:0 1px 0 rgba(255,255,255,.045); -webkit-app-region:drag; }
  .platform-darwin .appHeader { padding-top:30px; }
  .platform-darwin .appDragBar { padding-left:58px; }
  .appDragBar { height:42px; display:flex; align-items:center; gap:14px; }
  .appIdentity { min-width:0; display:flex; align-items:center; gap:10px; }
  .appMark { width:28px; height:28px; display:grid; place-items:center; flex:0 0 28px;
             border-radius:7px; background:#eceef1; color:#14171b; font-size:13px; font-weight:800; }
  .appTitleGroup { min-width:0; display:flex; flex-direction:column; gap:1px; }
  .appHeaderSub { max-width:440px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
                  color:#747d8b; font-size:10.5px; }
  .appHeaderStatus { display:flex; align-items:center; gap:7px; margin-left:auto; color:#7f8896; font-size:11px; }
  .appHeaderStatus i { width:7px; height:7px; border-radius:50%; background:#5f6875; }
  .appHeaderStatus.active { color:#a9cbb6; }
  .appHeaderStatus.active i { background:#55bd7d; box-shadow:0 0 7px rgba(85,189,125,.45); }
  .floatingSwitch { padding:6px 10px; background:#1b2027; border-color:#303741; color:#a8b0bc; font-size:11px; }
  .appHeader button, .tabs { -webkit-app-region:no-drag; }
  .workspace { min-width:0; min-height:0; flex:1; overflow:auto; overscroll-behavior:contain;
               padding:18px clamp(20px, 2.8vw, 44px) 28px; }
  .card { background:#15191e; border:0; border-radius:7px; padding:18px 20px;
          margin-bottom:14px; overflow:hidden; }
  .card > h3 { margin:0 0 14px; font-size:14px; color:#cfd6e0; display:flex; align-items:center; gap:9px; }
  .step { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
          border-radius:6px; background:#1d2942; color:#6f9bff; font-size:11px; font-weight:800; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .field { display:flex; min-width:0; flex-direction:column; gap:5px; }
  .field > label { font-size:11.5px; color:#6b7686; font-weight:700; }
  input[type=text], input[type=password], select, input[type=number], textarea {
    width:100%; min-width:0;
    background:#0f1319; border:1px solid #2a323e; color:#e7ebf0; border-radius:6px;
    padding:9px 11px; font-size:13px; font-family:inherit; outline:none; }
  input[type=text]:focus, input[type=password]:focus, select:focus, input[type=number]:focus, textarea:focus { border-color:#3d63c4; }
  input[type=text]:disabled, input[type=password]:disabled, select:disabled, input[type=number]:disabled, textarea:disabled { opacity:.5; }
  input[type=password] { -webkit-text-fill-color:#e7ebf0; box-shadow:0 0 0 1000px #0f1319 inset; }
  input:-webkit-autofill, input:-webkit-autofill:hover, input:-webkit-autofill:focus {
    -webkit-text-fill-color:#e7ebf0; transition:background-color 9999s ease-out 0s; box-shadow:0 0 0 1000px #0f1319 inset;
  }
  textarea { resize:vertical; }
  .dir { flex:1; min-width:0; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  button { background:#22304a; border:1px solid #2f4162; color:#dce6f5; border-radius:6px;
           padding:9px 15px; font-size:13px; font-family:inherit; cursor:pointer; font-weight:600; }
  button:hover:not(:disabled) { background:#2a3a58; border-color:#3d5480; }
  button:disabled { opacity:.42; cursor:not-allowed; }
  button.primary { background:#2f56b0; border-color:#3f6bd6; color:#fff; }
  button.primary:hover:not(:disabled) { background:#3761c4; }
  button.danger { background:#3a1f22; border-color:#5a2b30; color:#f0a9a9; }
  button.danger:hover:not(:disabled) { background:#4a2529; }
  button.ghost { background:transparent; border-color:#2a323e; color:#98a2b0; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700;
          padding:3px 10px; border-radius:6px; background:#1a2334; color:#7f9bd0; }
  .chip.ok { background:#14301f; color:#63c98a; }
  .chip.warn { background:#3a2c14; color:#e0b45c; }
  .chip.err { background:#3a1b1e; color:#e4878d; }
  .note { font-size:12.5px; color:#8b95a4; line-height:1.7; }
  .warnbox { background:#241a12; border:1px solid #4a3a20; border-left:3px solid #d9a53d;
             border-radius:0 10px 10px 0; padding:11px 14px; font-size:12.5px; color:#e0be86; margin-top:12px; }
  .errbox { background:#241216; border:1px solid #4a2026; border-left:3px solid #d9534f;
            border-radius:0 10px 10px 0; padding:11px 14px; font-size:12.5px; color:#eda5a8; margin-top:12px; }
  .okbox { background:#0f2417; border:1px solid #1f4530; border-left:3px solid #46a86a;
           border-radius:0 10px 10px 0; padding:11px 14px; font-size:12.5px; color:#93d2ab; margin-top:12px; }
  .bar { height:7px; background:#1a1f27; border-radius:99px; overflow:hidden; margin:12px 0 8px; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#3f6bd6,#6f9bff);
             transition:width .25s ease; }
  .phases { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
  .ph { font-size:11px; padding:3px 9px; border-radius:99px; background:#171c24; color:#5f6b7c; font-weight:700; }
  .ph.on { background:#1d2942; color:#7f9bd0; }
  .ph.done { background:#14301f; color:#63c98a; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:14px; }
  td { padding:7px 0; border-bottom:1px solid #1c222b; }
  td:last-child { text-align:right; font-variant-numeric:tabular-nums; font-weight:700; }
  tr:last-child td { border-bottom:none; }
  .muted { color:#6b7686; }
  .mono { font-family:ui-monospace,Consolas,monospace; font-size:12px; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:14px 18px; }
  @media (max-width:560px){ .grid2{ grid-template-columns:1fr; } }
  .deck { display:grid; gap:12px; align-items:start; }
  .deck > .card { margin-bottom:0; }
  .deck > .foot, .fullSpan { grid-column:1 / -1; }
  .translateDeck { display:grid; grid-template-columns:minmax(0, 1.18fr) minmax(340px, .82fr); gap:12px; align-items:start; }
  .translateMain, .translateSide { min-width:0; display:flex; flex-direction:column; }
  .translateMain, .translateSide { gap:1px; overflow:hidden; border-radius:8px; background:#242a31; }
  .translateMain > .card, .translateSide > .card { margin-bottom:0; border-radius:0; }
  @media (max-width:1200px){ .translateDeck { grid-template-columns:1fr; } }
  .settingsDeck { grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); }
  .settingsDeck > .card:first-child { grid-column:1 / -1; }
  .workbenchDeck { grid-template-columns:minmax(0, .96fr) minmax(340px, .84fr); }
  .workbenchDeck > .card:first-child, .workbenchDeck > .card:last-child { grid-column:1 / -1; }
  @media (max-width:1300px){ .workbenchDeck { grid-template-columns:1fr; } }
  .logsDeck { grid-template-columns:minmax(300px, 360px) minmax(0, 1fr); }
  @media (max-width:1180px){ .logsDeck { grid-template-columns:1fr; } }
  .foot { flex:0 0 auto; background:#12151a; box-shadow:0 -1px 0 rgba(255,255,255,.045);
          padding:11px clamp(20px, 2.8vw, 44px); }
  .footin { width:100%; margin:0; display:flex; gap:12px; align-items:center; }
  .spacer { flex:1; }
  .tabs { min-height:38px; display:flex; flex-wrap:wrap; align-items:flex-end; gap:2px; margin:0; padding:0; }
  .tab { background:transparent; border:none; border-bottom:2px solid transparent; border-radius:0;
         color:#7d8797; padding:9px 12px 10px; font-weight:700; font-size:12px; cursor:pointer; }
  .tab:hover:not(:disabled) { background:transparent; border-color:transparent; color:#a8b4c4; }
  .tab.active { color:#e5e8ed; border-bottom-color:#5e87e8; }
  .emptyState { min-height:220px; display:flex; align-items:center; justify-content:center; text-align:center; }
  .emptyState > div { max-width:460px; }
  .emptyState h4 { margin:0 0 8px; font-size:16px; color:#d7deea; }
  .emptyState p { margin:0; color:#8b95a4; line-height:1.8; font-size:13px; }
  .emptyTips { display:flex; flex-wrap:wrap; justify-content:center; gap:8px; margin-top:14px; }
  body.floating-mode, body.floating-mode #root {
    --floating-logo-size:28px;
    --floating-logo-radius:10px;
    --floating-logo-bg:#eef1f4;
    --floating-logo-shadow:inset 0 0 0 1px rgba(15,20,27,.2), inset 0 -1px 0 rgba(15,20,27,.1);
    background:transparent !important; overflow:hidden; color-scheme:dark;
  }
  body.floating-mode:not(.floating-expanded),
  body.floating-mode:not(.floating-expanded) #root {
    border-radius:var(--floating-logo-radius);
    clip-path:inset(0 round var(--floating-logo-radius));
  }
  .floatingOrbShell {
    isolation:isolate; width:100%; height:100%; position:relative; display:grid; place-items:center;
    overflow:hidden; border:0; border-radius:var(--floating-logo-radius);
    clip-path:inset(0 round var(--floating-logo-radius)); background:var(--floating-logo-bg);
    box-shadow:var(--floating-logo-shadow);
    -webkit-app-region:drag; cursor:grab;
  }
  .floatingOrbShell:active { cursor:grabbing; }
  .floatingOrbShell.active {
    box-shadow:inset 0 0 0 2px #4b9f6b, inset 0 -1px 0 rgba(15,20,27,.1);
  }
  .floatingOrb {
    z-index:1; position:relative; width:24px; height:24px; padding:0; border:0; border-radius:7px;
    display:grid; place-items:center; background:transparent; color:#13181e;
    -webkit-app-region:no-drag; touch-action:none; user-select:none; cursor:grab;
  }
  .floatingOrb:active { cursor:grabbing; }
  .floatingOrb:hover:not(:disabled) { background:rgba(15,20,27,.055); border:0; transform:none; }
  .floatingOrb:focus-visible { outline:1px solid #426fc9; outline-offset:-2px; }
  .floatingOrbMark { font-size:12px; line-height:1; font-weight:800; color:#13181e; }
  .floatingOrbDot {
    position:absolute; right:0; bottom:0; width:6px; height:6px; border-radius:50%;
    background:#98a1ac; border:1.5px solid #eef1f4;
  }
  .floatingOrbDot.active { background:#42a468; box-shadow:0 0 0 2px rgba(66,164,104,.16); }

  .floatingController {
    width:100%; height:100%; padding:10px 10px 9px; display:flex; flex-direction:column; gap:8px;
    overflow:hidden; border:1px solid #35404c; border-radius:14px; background:#13181e;
    box-shadow:inset 0 1px 0 rgba(255,255,255,.045), 0 14px 34px rgba(0,0,0,.46);
  }
  .floatingController.active { border-color:#3c5548; }
  .floatingController button { -webkit-app-region:no-drag; }
  .floatingControllerHeader {
    height:32px; flex:0 0 32px; display:flex; align-items:center; gap:8px;
    padding:0; -webkit-app-region:drag;
  }
  .floatingControllerLogo {
    width:var(--floating-logo-size); height:var(--floating-logo-size); padding:0; border:0;
    border-radius:var(--floating-logo-radius); flex:0 0 var(--floating-logo-size);
    background:var(--floating-logo-bg); color:#13181e; box-shadow:var(--floating-logo-shadow);
    font-size:12px; line-height:1; font-weight:800; touch-action:none; user-select:none; cursor:grab;
  }
  .floatingControllerLogo:active { cursor:grabbing; }
  .floatingControllerLogo:hover:not(:disabled) { background:#fff; border:0; }
  .floatingControllerHeading { min-width:0; flex:1; display:flex; flex-direction:column; gap:1px; }
  .floatingControllerHeading strong { font-size:12.5px; line-height:1.2; color:#f0f3f6; white-space:nowrap; }
  .floatingControllerHeading span {
    display:flex; align-items:center; gap:5px; font-size:9.5px; line-height:1.2; color:#7c8794;
  }
  .floatingControllerHeading span i {
    width:5px; height:5px; flex:0 0 5px; border-radius:50%; background:#647080;
  }
  .floatingControllerHeading span.active { color:#85c99d; }
  .floatingControllerHeading span.active i { background:#65cf8d; box-shadow:0 0 5px rgba(101,207,141,.45); }
  .floatingWindowActions { display:flex; gap:4px; }
  .floatingWindowActions button {
    width:27px; height:27px; padding:0; display:grid; place-items:center; border-radius:7px;
    background:transparent; border-color:transparent; color:#8994a2;
  }
  .floatingWindowActions button:hover:not(:disabled) {
    background:#202730; border-color:#313c49; color:#edf0f4;
  }
  .floatingCommandSurface {
    flex:0 0 98px; overflow:hidden; border-radius:9px; background:#181e25;
    box-shadow:inset 0 0 0 1px #303a46;
  }
  .floatingGameSelector {
    width:100%; height:44px; flex:0 0 44px; display:flex; align-items:center; gap:9px;
    padding:6px 8px; text-align:left; background:transparent; border:0; border-radius:0;
  }
  .floatingGameSelector:hover:not(:disabled) { background:#202832; border:0; }
  .floatingGameGlyph {
    width:29px; height:29px; flex:0 0 29px; display:grid; place-items:center;
    border-radius:7px; background:#252d37; color:#8995a4;
  }
  .floatingGameGlyph.ready { background:#193326; color:#74d098; }
  .floatingGameText { min-width:0; flex:1; display:flex; flex-direction:column; gap:1px; }
  .floatingGameText strong, .floatingGameText small { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .floatingGameText strong { color:#e8ebef; font-size:11.5px; line-height:1.3; }
  .floatingGameText small { color:#75808d; font-size:9.5px; line-height:1.3; }
  .floatingArrow { flex:0 0 16px; color:#66717e; }
  .floatingQuickActions {
    height:54px; display:grid; grid-template-columns:1fr 1fr; gap:0;
    border-top:1px solid #303a46;
  }
  .floatingQuickButton {
    min-width:0; height:54px; padding:7px 8px; display:flex; align-items:center; justify-content:flex-start; gap:7px;
    border:0; border-radius:0; background:transparent; color:#dce1e7;
  }
  .floatingQuickButton + .floatingQuickButton { border-left:1px solid #303a46; }
  .floatingQuickButton:hover:not(:disabled) { background:#202832; border-color:#303a46; }
  .floatingQuickButton:disabled { opacity:.46; }
  .floatingActionIcon {
    width:30px; height:30px; flex:0 0 30px; display:grid; place-items:center;
    border-radius:7px; background:#262e38; color:#828e9d;
  }
  .floatingQuickButton.runtime:not(:disabled) .floatingActionIcon { background:#193b2a; color:#79d39b; }
  .floatingQuickButton.static:not(:disabled) .floatingActionIcon { background:#1c304c; color:#8eb5ee; }
  .floatingQuickButton.running:not(:disabled) .floatingActionIcon { background:#4a252b; color:#ee9ca4; }
  .floatingActionCopy { min-width:0; display:flex; flex-direction:column; gap:1px; text-align:left; }
  .floatingActionCopy strong, .floatingActionCopy small {
    overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
  }
  .floatingActionCopy strong { color:inherit; font-size:10.5px; line-height:1.25; }
  .floatingActionCopy small { color:#75808d; font-size:8.5px; line-height:1.25; font-weight:500; }
  .floatingControllerStatus {
    position:relative; min-height:34px; margin-top:auto; padding:6px 2px 2px;
    display:grid; grid-template-columns:minmax(0, 1fr) auto; align-items:center; gap:6px;
    overflow:hidden; border-radius:0; background:transparent; border:0; border-top:1px solid #29323c;
    box-shadow:none; color:#858f9c; font-size:9.5px;
  }
  .floatingControllerStatus.active { color:#c1cbd4; border-top-color:#304c3c; box-shadow:none; }
  .floatingStatusLine { min-width:0; display:flex; align-items:center; gap:6px; }
  .floatingStatusLine > span:last-child { min-width:0; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .floatingStatusDot { width:6px; height:6px; flex:0 0 6px; border-radius:50%; background:#5f6b79; }
  .floatingControllerStatus.active .floatingStatusDot { background:#65cf8d; box-shadow:0 0 5px rgba(101,207,141,.5); }
  .floatingStatusTools { min-width:0; display:flex; align-items:center; gap:4px; }
  .floatingStatusTools > span {
    max-width:70px; min-width:0; display:flex; align-items:center; gap:4px;
    overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:#697583; font-size:9px;
  }
  .floatingStatusTools > span i {
    width:5px; height:5px; flex:0 0 5px; border-radius:50%; background:#bd8733;
  }
  .floatingStatusTools > span.ready i { background:#65b985; }
  .floatingStatusTools button {
    width:26px; height:26px; flex:0 0 26px; padding:0; display:grid; place-items:center;
    border:0; border-radius:7px; background:transparent; color:#788492;
  }
  .floatingStatusTools button:hover:not(:disabled) { background:#202832; border:0; color:#e4e8ed; }
  .floatingProgress { position:absolute; left:0; right:0; bottom:0; height:2px; background:#18202a; }
  .floatingProgress i { display:block; height:100%; background:#5f8fe7; transition:width .25s ease; }
`;

export default function App(): React.ReactElement {
  if (window.location.hash === '#floating') {
    return (
      <>
        <style>{css}</style>
        <FloatingPanel />
      </>
    );
  }

  const api = window.baibao;

  const [gameDir, setGameDir] = React.useState('');
  const [engine, setEngine] = React.useState<EngineInfo | null>(null);
  const [detecting, setDetecting] = React.useState(false);

  const [from, setFrom] = React.useState('ja');
  const [to, setTo] = React.useState('zh-CN');
  const [limit, setLimit] = React.useState('');       // 空 = 全部
  const [repack, setRepack] = React.useState(true);
  const [injectFont, setInjectFont] = React.useState(true);
  const [providerId, setProviderId] = React.useState('auto');

  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<ProgressEvent | null>(null);
  // ── 一键汉化（运行时）──
  const [rtRunning, setRtRunning] = React.useState(false);
  const [rtMsg, setRtMsg] = React.useState<string | null>(null);
  const [rtInfo, setRtInfo] = React.useState<{
    requested?: number; localHits?: number; apiGot?: number; storeSize?: number; providerName?: string;
  } | null>(null);
  /** 是否正把东西拖在窗口上（给个视觉反馈，否则用户不知道"能不能拖"） */
  const [dragging, setDragging] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [restored, setRestored] = React.useState<RestoreOutcome | null>(null);
  const [error, setError] = React.useState('');

  const [env, setEnv] = React.useState<{ dbPath: string; hasApiKey: boolean } | null>(null);
  /** 当前启用的接口方案名（方案可切换，界面上要如实显示用的哪个） */
  const [profileName, setProfileName] = React.useState('');
  /** 所有引擎的声明式配置（界面据此自适应） */
  const [engines, setEngines] = React.useState<EngineManifestView[]>([]);
  /** 默认翻译方向只从配置应用一次，之后以用户当前选择为准 */
  const appliedDefaults = React.useRef(false);
  const detectRequest = React.useRef(0);
  const currentGameDir = React.useRef('');
  /** 页签：汉化（主线闭环）/ 工作台（人工修订） */
  const [tab, setTab] = React.useState<'translate' | 'workbench' | 'settings' | 'logs'>('translate');

  // 订阅一次即可（依赖为空）。返回的取消订阅函数必须在卸载时调用，
  // 否则开发模式热更新会让监听越叠越多 —— 表现为进度条跳动、结果重复。
  const refreshEnvironment = React.useCallback(async (): Promise<void> => {
    const [envResult, cfgResult, runtimeResult] = await Promise.all([
      api.env(),
      api.cfgStatus(),
      api.runtimeStatus(),
    ]);
    if (envResult.ok && envResult.data) {
      setEnv({ dbPath: envResult.data.dbPath, hasApiKey: envResult.data.hasApiKey });
      setRunning(envResult.data.translating);
    }
    if (runtimeResult.ok && runtimeResult.data) {
      const runtime = runtimeResult.data as typeof rtInfo & { running?: boolean };
      setRtRunning(!!runtime.running);
      setRtInfo(runtime.running ? runtime : null);
    }
    if (cfgResult.ok && cfgResult.data) {
      const c = cfgResult.data as CfgView;
      setProfileName(c.activeProfile?.name ?? '');
      if (!appliedDefaults.current) {
        appliedDefaults.current = true;
        if (c.config.defaultFrom) setFrom(c.config.defaultFrom);
        if (c.config.defaultTo) setTo(c.config.defaultTo);
      }
    }
  }, [api]);

  React.useEffect(() => {
    const offP = api.onProgress((p) => setProgress(p));
    const offF = api.onFinished((r) => {
      setRunning(false);
      if (r.ok && r.data) {
        setOutcome(r.data);
        setError('');
      } else {
        setError(r.error ?? '未知错误');
      }
    });
    void api.engines().then((r) => {
      if (r.ok && Array.isArray(r.data)) setEngines(r.data as EngineManifestView[]);
    });
    // 默认翻译方向来自配置（用户可在配置页改）。
    // ⚠️ 只应用一次：用户在界面上改过之后，不能被配置回读覆盖掉。
    return () => {
      offP();
      offF();
    };
  }, [api, refreshEnvironment]);

  /** 定下游戏目录后统一走这一步：立刻识别引擎（"选错目录"要马上告诉用户，而不是等点了开始才报错） */
  const adoptDir = React.useCallback(async (dir: string): Promise<void> => {
    const request = ++detectRequest.current;
    currentGameDir.current = dir;
    setError('');
    setOutcome(null);
    setRestored(null);
    setGameDir(dir);
    try {
      window.localStorage.setItem(LAST_GAME_DIR_KEY, dir);
    } catch {
      // 本地偏好写入失败不影响当前任务。
    }
    setDetecting(true);
    try {
      const d = await api.detect(dir);
      if (request !== detectRequest.current) return;
      if (!d.ok || !d.data) {
        setEngine(null);
        setError(d.error ?? '识别失败');
        return;
      }
      setEngine(d.data);
    } catch (detectError) {
      if (request !== detectRequest.current) return;
      setEngine(null);
      setError((detectError as Error).message || '识别失败');
    } finally {
      if (request === detectRequest.current) setDetecting(false);
    }
  }, [api]);

  React.useEffect(() => {
    const syncSharedState = (): void => {
      void refreshEnvironment();
      const sharedGameDir = readSharedGameDir();
      if (sharedGameDir && sharedGameDir !== currentGameDir.current) {
        void adoptDir(sharedGameDir);
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') syncSharedState();
    };
    const onStorage = (event: StorageEvent): void => {
      if (event.key === LAST_GAME_DIR_KEY) syncSharedState();
    };

    syncSharedState();
    window.addEventListener('focus', syncSharedState);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', syncSharedState);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [adoptDir, refreshEnvironment]);

  /** 选目录（按钮） */
  const chooseDir = async (): Promise<void> => {
    const r = await api.pickGameDir();
    if (!r.ok) {
      setError(r.error ?? '选择目录失败');
      return;
    }
    if (!r.data) return; // 用户取消
    await adoptDir(r.data);
  };

  const toggleFloating = async (): Promise<void> => {
    const result = await api.floatingOpen();
    if (!result.ok || !result.data) {
      setError(result.error ?? '切换悬浮窗失败');
      return;
    }
  };

  /**
   * 拖进来就认（拖 `Game.exe` 或拖游戏文件夹都行）。
   *
   * 路径折算放主进程做：渲染层拿不到可靠的文件类型（`File` 对象对目录和文件长得一样）。
   */
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault();
    setDragging(false);
    // 不是拖文件就别管（在窗口里拖选一段文字也会触发 drop —— 那时不该弹错）
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const f = files[0] as File & { path?: string };
    const p = f.path;
    if (!p) {
      setError('读不到拖进来的路径 —— 请改用「选择目录…」按钮');
      return;
    }
    const r = await api.adoptPath(p);
    if (!r.ok || !r.data) {
      setError(r.error ?? '这个路径用不了');
      return;
    }
    await adoptDir(r.data);
  };

  const start = async (): Promise<void> => {
    if (!gameDir) return;
    setError('');
    setOutcome(null);
    setRestored(null);
    setProgress({ phase: 'extract', current: 0, total: 0, message: '准备中…' });
    setRunning(true);
    const r = await api.startTranslate({
      gameDir,
      from,
      to,
      limit: limit.trim() ? Number(limit) : undefined,
      repack,
      injectFont,
      providerId: providerId === 'auto' ? undefined : providerId,
    });
    if (!r.ok) {
      setRunning(false);
      setError(r.error ?? '启动失败');
      setProgress(null);
      return;
    }
  };

  const cancel = async (): Promise<void> => {
    const r = await api.cancelTranslate();
    if (!r.ok) setError(r.error ?? '取消失败');
  };

  const doRestore = async (): Promise<void> => {
    if (!gameDir) return;
    // 还原是**改写游戏文件**的操作，必须二次确认（工程红线：可逆，但不能误触）
    const yes = window.confirm(
      `确定要还原吗？\n\n${gameDir}\n\n会把我们对这个游戏做的所有改动（回写 + 字体）\n` +
      `按补丁倒序展开，回到翻译前的状态。`,
    );
    if (!yes) return;
    setError('');
    setRestored(null);
    const r = await api.restore(gameDir);
    if (!r.ok || !r.data) {
      setError(r.error ?? '还原失败');
      return;
    }
    setRestored(r.data);
  };

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.max(0, Math.round((progress.current / progress.total) * 100)))
    : (progress?.phase === 'done' ? 100 : 0);

  const phaseState = (ph: ProgressEvent['phase']): string => {
    if (!progress) return 'ph';
    if (progress.phase === ph) return 'ph on';
    const hit = PHASE_ORDER.indexOf(progress.phase);
    const self = PHASE_ORDER.indexOf(ph);
    if (self >= 0 && hit >= 0 && self < hit) return 'ph done';
    return 'ph';
  };

  /**
   * 当前识别到的引擎的声明式配置。
   * 识别出来之前为 undefined —— 界面此时就用通用文案，而不是硬编码 MV/MZ 的说法。
   */
  const cur = React.useMemo(
    () => engines.find((e) => e.id === engine?.engineId),
    [engines, engine],
  );

  /** 源语言候选：优先用引擎给的；没有则给一组通用兜底 */
  const srcLangs = cur?.sourceLanguages?.length
    ? cur.sourceLanguages
    : [
        { id: 'ja', label: '日语 ja' },
        { id: 'en', label: '英语 en' },
        { id: 'ko', label: '韩语 ko' },
        { id: 'zh-CN', label: '简体中文 zh-CN' },
      ];

  /** 一键汉化：装桥 → 启动游戏 → 边玩边翻。关闭游戏即自动还原（改动可逆）。 */
  const doRuntimeStart = async (): Promise<void> => {
    if (!gameDir) return;
    setRtRunning(true);
    setRtInfo(null);
    setRtMsg('正在装入运行时桥并启动游戏…（首次启动可能要等游戏加载完）');
    const r = await api.runtimeStart(gameDir);
    if (!r.ok) {
      setRtRunning(false);
      setRtMsg(`启动失败：${r.error}`);
      return;
    }
    const d = r.data as { engine?: string; providerName?: string };
    setRtMsg(`已接管：${d.engine} · ${d.providerName}。关闭游戏后会自动还原游戏文件。`);
  };

  const doRuntimeStop = async (): Promise<void> => {
    setRtMsg('正在收尾（结束游戏 + 还原游戏文件）…');
    const r = await api.runtimeStop();
    setRtRunning(!r.ok);
    setRtMsg(r.ok ? '已收尾：游戏文件已逐字节还原。' : `收尾失败，可再次重试：${r.error}`);
  };

  // 运行中轮询状态（显示"取了词多少条 / 命中本地多少条"），游戏一关就自动结束
  React.useEffect(() => {
    if (!rtRunning) return;
    let stop = false;
    const tick = async (): Promise<void> => {
      const r = await api.runtimeStatus();
      if (stop || !r.ok) return;
      const d = r.data as {
        running?: boolean; requested?: number; localHits?: number; apiGot?: number;
        storeSize?: number; providerName?: string;
        stopping?: boolean;
        cleanupError?: string;
        last?: { cleanupError?: string };
      };
      if (!d.running) {
        setRtRunning(false);
        setRtMsg(d.last?.cleanupError
          ? `游戏已关闭，但自动还原失败：${d.last.cleanupError}`
          : '游戏已关闭，游戏文件已自动还原。');
        return;
      }
      if (d.cleanupError) {
        setRtMsg(`自动还原失败，可点击「结束并还原」重试：${d.cleanupError}`);
        return;
      }
      if (d.stopping) setRtMsg('游戏已关闭，正在校验并还原游戏文件…');
      setRtInfo(d);
    };
    void tick();
    const h = window.setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      window.clearInterval(h);
    };
  }, [rtRunning]);

  const busy = running || detecting || rtRunning;
  // 方案是"名字 + 地址 + 模型"，所以显示当前启用的**方案名** —— 比只显示 providerId 有用
  const activeProfileName = profileName || '（未读取配置）';
  const effectiveProvider = providerId === 'auto'
    ? (env?.hasApiKey ? `${activeProfileName}（可用）` : `stub 本地假机翻（方案「${activeProfileName}」未就绪）`)
    : providerId;
  const selectedGameName = gameDir
    ? gameDir.split(/[\\/]/).filter(Boolean).at(-1) ?? gameDir
    : '';
  const activityLabel = running
    ? '静态汉化中'
    : rtRunning
      ? '运行时汉化中'
      : detecting
        ? '正在识别'
        : '空闲';

  return (
    <>
      <style>{css}</style>
      <div
        className={`wrap platform-${api.platform}${dragging ? ' dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          if (!dragging) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => void onDrop(e)}
      >
        <header className="appHeader">
          <div className="appDragBar">
            <div className="appIdentity">
              <div className="appMark">白</div>
              <div className="appTitleGroup">
                <h1>白的百宝箱</h1>
                <div className="appHeaderSub">
                  {dragging
                    ? '松手即可识别游戏'
                    : selectedGameName
                      ? `${selectedGameName}${engine?.engineName ? ` · ${engine.engineName}` : ''}`
                      : '游戏汉化工作台'}
                </div>
              </div>
            </div>
            <div className={`appHeaderStatus${busy ? ' active' : ''}`}>
              <i />
              {activityLabel}
            </div>
            <button className="floatingSwitch" onClick={() => void toggleFloating()}>
              悬浮球
            </button>
          </div>

          <nav className="tabs" aria-label="主功能">
            <button className={`tab${tab === 'translate' ? ' active' : ''}`} onClick={() => setTab('translate')}>
              汉化
            </button>
            <button className={`tab${tab === 'workbench' ? ' active' : ''}`} onClick={() => setTab('workbench')}>
              工作台{engine?.ok ? '' : '（需先选游戏）'}
            </button>
            <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
              配置{env?.hasApiKey ? '' : ' · 未就绪'}
            </button>
            <button className={`tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>
              日志
            </button>
          </nav>
        </header>

        <main className="workspace">
        {tab === 'settings' && (
          <div className="deck settingsDeck">
            <Settings onChanged={() => void refreshEnvironment()} />
          </div>
        )}
        {tab === 'logs' && (
          <div className="deck logsDeck">
            <Logs />
          </div>
        )}

        {tab === 'workbench' && (
          <div className="deck workbenchDeck">
            <Workbench gameDir={gameDir} from={from} to={to} />
          </div>
        )}

        {tab === 'translate' && (
        <div className="translateDeck">
          <div className="translateMain">
        {/* ── 1. 选游戏 ── */}
        <div className="card">
          <h3><span className="step">1</span>选择游戏目录</h3>
          <div className="row">
            <input
              className="dir"
              type="text"
              readOnly
              value={gameDir || '（还没选）'}
              placeholder={cur?.rootHint || '点右边按钮选择游戏目录'}
            />
            <button onClick={chooseDir} disabled={busy}>选择目录…</button>
            <button
              className="ghost"
              disabled={!gameDir}
              onClick={() => void api.reveal(gameDir)}
            >打开</button>
          </div>

          {detecting && <div className="note" style={{ marginTop: 12 }}>正在识别引擎…</div>}

          {engine && !detecting && (
            <div style={{ marginTop: 14 }}>
              <div className="row">
                {engine.ok
                  ? <span className="chip ok">已识别：{engine.engineName}</span>
                  : <span className="chip err">未识别出引擎</span>}
                {engine.ok && engine.confidence !== undefined && (
                  <span className="chip">置信度 {engine.confidence}</span>
                )}
                {engine.encrypted && <span className="chip warn">数据已加密</span>}
                <span className="chip mono">{engine.gameId}</span>
              </div>
              {engine.notes.length > 0 && (
                <div className="note" style={{ marginTop: 10 }}>
                  {engine.notes.map((n, i) => <div key={i}>· {n}</div>)}
                </div>
              )}
              {!engine.ok && engine.message && <div className="warnbox">{engine.message}</div>}
              {!engine.ok && engine.candidates.length > 0 && (
                <div className="note" style={{ marginTop: 8 }}>
                  最接近的候选：{engine.candidates.join('、')}
                </div>
              )}
              {cur?.caveats && cur.caveats.length > 0 && (
                <div className="note" style={{ marginTop: 10 }}>
                  <div style={{ marginBottom: 4 }}>该引擎的已知情况：</div>
                  {cur.caveats.map((c, i) => <div key={i}>· {c}</div>)}
                </div>
              )}
              {engine.encrypted && (
                <div className="warnbox">
                  这个游戏的数据文件被加密了，<b>静态改文件</b>这条路走不通。
                  请用下面的「<b>一键汉化并启动</b>」（运行时汉化）：它在游戏运行时取词，
                  不依赖读取被加密的数据文件。
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── 2. 选项 ── */}
        <div className="card">
          <h3><span className="step">2</span>翻译选项</h3>
          <div className="grid2">
            <div className="field">
              <label>源语言</label>
              {/* 候选来自引擎自己的 manifest（各引擎受众不同，顺序/默认也不同） */}
              <select value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy}>
                {srcLangs.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>目标语言</label>
              <select value={to} onChange={(e) => setTo(e.target.value)} disabled={busy}>
                <option value="zh-CN">简体中文 zh-CN</option>
                <option value="zh-TW">繁體中文 zh-TW</option>
                <option value="en">英语 en</option>
              </select>
            </div>
            <div className="field">
              <label>试译条数（留空 = 全部）</label>
              <input
                type="number" min={1} value={limit} placeholder="例如 30，先看效果"
                onChange={(e) => setLimit(e.target.value)} disabled={busy}
              />
            </div>
            <div className="field">
              <label>翻译引擎</label>
              <select value={providerId} onChange={(e) => setProviderId(e.target.value)} disabled={busy}>
                <option value="auto">当前方案（{activeProfileName}）</option>
                <option value="stub">本地假机翻（只验证流程）</option>
              </select>
            </div>
          </div>

          <div className="row" style={{ marginTop: 16 }}>
            <label className="note" style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={repack} disabled={busy}
                     onChange={(e) => setRepack(e.target.checked)} />
              回写游戏文件（取消勾选 = 只抽取入库，先检查抽得对不对）
            </label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="note" style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={injectFont} disabled={busy}
                     onChange={(e) => setInjectFont(e.target.checked)} />
              注入中文字体（解决译文显示成方框）
            </label>
          </div>

          {cur?.fontOptionNote && (
            <div className="note" style={{ marginTop: 6, paddingLeft: 22 }}>
              字体注入会做什么：{cur.fontOptionNote}
            </div>
          )}

          <div className="note" style={{ marginTop: 14 }}>
            当前翻译引擎：<b style={{ color: '#a8b4c4' }}>{effectiveProvider}</b>
            {env && <> ｜ 文本库：<span className="mono">{env.dbPath}</span></>}
          </div>
          {!env?.hasApiKey && (
            <div className="warnbox">
              当前接口方案尚未配置可用的密钥。
              现在会用<b>本地假机翻</b>（译文是 <span className="mono">【中】原文</span>）——
              它只用来验证"抽取 → 入库 → 回写 → 字体 → 还原"整条链路，
              <b>不是真翻译</b>。要看真实效果，请先在「配置」页完成连接测试。
            </div>
          )}
        </div>

        {/* ── 3. 进度 / 结果 ── */}
        {(running || outcome || error) && (
          <div className="card">
            <h3><span className="step">3</span>{running ? '进行中' : '结果'}</h3>

            {progress && (
              <>
                <div className="row">
                  <span className="chip on">{
                    PHASE_LABEL[progress.phase]
                  }{progress.total > 0 ? ` ${progress.current}/${progress.total}` : ''}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{progress.message ?? ''}</span>
                </div>
                <div className="bar"><i style={{ width: `${pct}%` }} /></div>
                <div className="phases">
                  {PHASE_ORDER.map((ph) => (
                    <span className={phaseState(ph)} key={ph}>{PHASE_LABEL[ph]}</span>
                  ))}
                </div>
              </>
            )}

            {outcome && (
              <>
                {outcome.report.cancelled && (
                  <div className="warnbox">任务已取消。已经完成的译文仍保存在本地，重新开始会从断点继续。</div>
                )}
                <table>
                  <tbody>
                    <tr><td>引擎 / 翻译源</td><td>{outcome.engineName} ｜ {outcome.providerName}</td></tr>
                    <tr><td>抽取</td><td>{outcome.report.extracted}</td></tr>
                    <tr><td>已是我们写回的（跳过）</td><td>{outcome.report.alreadyApplied}</td></tr>
                    <tr><td>新增入库</td><td>{outcome.report.upsert.inserted}</td></tr>
                    <tr><td>原文变更重译</td><td>{outcome.report.upsert.invalidated}</td></tr>
                    <tr><td>待译</td><td>{outcome.report.candidates}</td></tr>
                    <tr><td>命中翻译记忆（省下机翻）</td><td>{outcome.report.fromCache}</td></tr>
                    <tr><td>翻译成功</td><td>{outcome.report.translated}</td></tr>
                    <tr>
                      <td>控制符冲突 <span className="muted">（已拒绝写回）</span></td>
                      <td style={{ color: outcome.report.conflicts ? '#e0b45c' : undefined }}>
                        {outcome.report.conflicts}
                      </td>
                    </tr>
                    <tr>
                      <td>翻译失败</td>
                      <td style={{ color: outcome.report.failed ? '#e4878d' : undefined }}>
                        {outcome.report.failed}
                      </td>
                    </tr>
                    {outcome.report.repack && (
                      <>
                        <tr><td>回写</td><td>{outcome.report.repack.written}</td></tr>
                        <tr>
                          <td>备份目录</td>
                          <td className="mono" style={{ fontWeight: 400, fontSize: 11 }}>
                            {outcome.report.repack.backupDir
                              ? <button className="ghost" style={{ padding: '3px 9px', fontSize: 11 }}
                                  onClick={() => void api.reveal(outcome.report.repack!.backupDir!)}
                                >打开备份</button>
                              : '—'}
                          </td>
                        </tr>
                      </>
                    )}
                    {outcome.report.font && (
                      <tr><td>字体</td><td style={{ fontWeight: 400, fontSize: 12 }}>{outcome.report.font.detail}</td></tr>
                    )}
                    <tr><td>耗时</td><td>{outcome.durationMs}ms</td></tr>
                  </tbody>
                </table>

                {outcome.autoStub && (
                  <div className="warnbox">
                    本次用的是<b>本地假机翻</b>，译文形如 <span className="mono">【中】原文</span>。
                    流程验证有效，但不是真实翻译。
                  </div>
                )}
                {outcome.report.conflicts > 0 && (
                  <div className="warnbox">
                    有 {outcome.report.conflicts} 条译文与控制符占位不一致，<b>已拒绝写回</b>（不会破坏游戏）。
                    这些需要人工处理 —— 这正是下一步"人工修订工作台"要解决的。
                  </div>
                )}
                {outcome.report.errors.length > 0 && (
                  <div className="errbox">
                    {outcome.report.errors.map((e, i) => <div key={i}>错误：{e}</div>)}
                  </div>
                )}
                {outcome.report.errors.length === 0 && !outcome.report.cancelled && (
                  <div className="okbox">
                    完成。可以进游戏看看效果；不满意随时用下面的"一键还原"回到翻译前。
                  </div>
                )}
              </>
            )}

            {error && <div className="errbox">{error}</div>}
          </div>
        )}
          </div>
          <div className="translateSide">
            {/* ── 2.5 一键汉化（运行时）── */}
            <div className="card">
              <h3><span className="step">R</span>一键汉化并启动（运行时 · 推荐）</h3>
              <div className="note">
                启动游戏时把"运行时桥"装进去，<b>边玩边翻</b>：<b>不改游戏数据文件</b>，
                数据被加密的游戏同样有效，<b>关闭游戏即自动逐字节还原</b>。
                译文走上面配置的接口，并本地积累成译文库（第二次启动瞬时且不再花钱）。
                目前支持 RPG Maker MV / MZ。
              </div>
              <div className="row" style={{ marginTop: 14, gap: 10, display: 'flex', alignItems: 'center' }}>
                <button
                  className="primary"
                  disabled={!gameDir || busy || cur?.capabilities.runtimeHook === false}
                  onClick={() => void doRuntimeStart()}
                >
                  {rtRunning ? '汉化运行中…' : '一键汉化并启动'}
                </button>
                <button className="ghost" disabled={!rtRunning} onClick={() => void doRuntimeStop()}>
                  结束并还原
                </button>
                {rtRunning && rtInfo && (
                  <span className="row" style={{ gap: 8 }}>
                    <span className="chip on">运行中</span>
                    <span className="chip">取词 {rtInfo.requested ?? 0}</span>
                    <span className="chip">本地命中 {rtInfo.localHits ?? 0}</span>
                    <span className="chip">接口得译文 {rtInfo.apiGot ?? 0}</span>
                    <span className="chip mono">译文库 {rtInfo.storeSize ?? 0}</span>
                  </span>
                )}
              </div>
              {rtMsg && <div className="note" style={{ marginTop: 10 }}>{rtMsg}</div>}
            </div>

            {restored && (
              <div className="card">
                <h3>还原结果</h3>
                {restored.nothingToDo
                  ? <div className="okbox">没有需要还原的改动（这个游戏还没被我们改过）。</div>
                  : restored.errors.length === 0
                    ? <div className="okbox">展开 {restored.patches} 个补丁，还原 {restored.restored} 个文件，已回到翻译前状态。</div>
                    : <div className="warnbox">已还原 {restored.restored} 个文件，但仍有错误；未完成的补丁可再次重试。</div>}
                {restored.errors.length > 0 && (
                  <div className="errbox">{restored.errors.map((e, i) => <div key={i}>错误：{e}</div>)}</div>
                )}
              </div>
            )}
          </div>
        </div>)}
        </main>
      </div>

      {/* ── 底部操作条 ── */}
      {tab === 'translate' && <div className="foot">
        <div className="footin">
          <button
            className="primary"
            disabled={!gameDir || busy || !!engine?.encrypted || (engine ? !engine.ok : false)}
            onClick={start}
          >{running ? '汉化中…' : '开始汉化'}</button>
          <button className="danger" disabled={!gameDir || busy} onClick={doRestore}>
            一键还原
          </button>
          {running && <button className="ghost" onClick={() => void cancel()}>取消任务</button>}
          <div className="spacer" />
          {running && <span className="muted" style={{ fontSize: 12 }}>正在处理，请勿关闭窗口</span>}
          {detecting && <span className="muted" style={{ fontSize: 12 }}>识别中…</span>}
          {rtRunning && <span className="muted" style={{ fontSize: 12 }}>运行时汉化中</span>}
        </div>
      </div>}
    </>
  );
}
