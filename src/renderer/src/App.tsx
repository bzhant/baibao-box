import React from 'react';
import Workbench from './Workbench';
import Settings from './Settings';
import Logs from './Logs';

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
    openaiBaseUrl: string; openaiModel: string;
    defaultFrom: string; defaultTo: string;
    batchSize: number; concurrency: number; backupBeforeRepack: boolean;
  };
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
  /** 一键汉化：装桥 → 启动游戏 → 边玩边翻（关闭游戏即自动还原） */
  runtimeStart(gameDir: string): Promise<IpcResult<unknown>>;
  /** 收尾：结束游戏 + 逐字节还原游戏文件 */
  runtimeStop(): Promise<IpcResult<unknown>>;
  /** 运行时会话状态（界面轮询显示进度） */
  runtimeStatus(): Promise<IpcResult<unknown>>;
  restore(d: string): Promise<IpcResult<RestoreOutcome>>;
  reveal(p: string): Promise<IpcResult<true>>;
  env(): Promise<IpcResult<{ dbPath: string; hasApiKey: boolean; translating: boolean }>>;
  onProgress(cb: (p: ProgressEvent) => void): () => void;
  onFinished(cb: (r: IpcResult<Outcome>) => void): () => void;
  // 人工修订工作台（工作台）
  wbList(gameDir: string, q: Record<string, unknown>): Promise<IpcResult<unknown>>;
  wbSave(gameDir: string, path: string, key: string, translated: string | null, status?: string): Promise<IpcResult<{ changed: boolean }>>;
  wbBulk(gameDir: string, opt: Record<string, unknown>): Promise<IpcResult<unknown>>;
  wbPickExport(): Promise<IpcResult<string | null>>;
  wbExport(gameDir: string, outFile: string): Promise<IpcResult<unknown>>;
  wbPickImport(): Promise<IpcResult<string | null>>;
  wbImport(gameDir: string, inFile: string): Promise<IpcResult<unknown>>;
  wbRepackPreview(gameDir: string): Promise<IpcResult<unknown>>;
  wbRepack(gameDir: string): Promise<IpcResult<unknown>>;
  engines(): Promise<IpcResult<unknown>>;
  cfgStatus(): Promise<IpcResult<unknown>>;
  cfgUpdate(patch: Record<string, unknown>): Promise<IpcResult<unknown>>;
  cfgSetKey(key: string): Promise<IpcResult<{ encrypted: boolean }>>;
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

// ── 样式（沿用既有的深色基调，只补本页需要的部分） ───────────────────────

const css = `
  * { box-sizing: border-box; }
  body { margin:0; font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
         background:#0f1115; color:#e7ebf0; -webkit-font-smoothing:antialiased; }
  .wrap { max-width:1080px; margin:0 auto; padding:34px 26px 90px; }
  .kicker { font-size:11px; letter-spacing:.18em; color:#6b7686; font-weight:700; text-transform:uppercase; }
  h1 { font-size:26px; margin:8px 0 4px; letter-spacing:-.01em; }
  .sub { color:#98a2b0; font-size:13.5px; margin-bottom:26px; }
  .card { background:#151920; border:1px solid #232a35; border-radius:14px; padding:18px 20px; margin-bottom:16px; }
  .card > h3 { margin:0 0 14px; font-size:14px; color:#cfd6e0; display:flex; align-items:center; gap:9px; }
  .step { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
          border-radius:6px; background:#1d2942; color:#6f9bff; font-size:11px; font-weight:800; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .field { display:flex; flex-direction:column; gap:5px; }
  .field > label { font-size:11.5px; color:#6b7686; font-weight:700; }
  input[type=text], select, input[type=number] {
    background:#0f1319; border:1px solid #2a323e; color:#e7ebf0; border-radius:9px;
    padding:9px 11px; font-size:13px; font-family:inherit; outline:none; }
  input[type=text]:focus, select:focus, input[type=number]:focus { border-color:#3d63c4; }
  input[type=text]:disabled, select:disabled, input[type=number]:disabled { opacity:.5; }
  .dir { flex:1; min-width:300px; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
  button { background:#22304a; border:1px solid #2f4162; color:#dce6f5; border-radius:9px;
           padding:9px 15px; font-size:13px; font-family:inherit; cursor:pointer; font-weight:600; }
  button:hover:not(:disabled) { background:#2a3a58; border-color:#3d5480; }
  button:disabled { opacity:.42; cursor:not-allowed; }
  button.primary { background:#2f56b0; border-color:#3f6bd6; color:#fff; }
  button.primary:hover:not(:disabled) { background:#3761c4; }
  button.danger { background:#3a1f22; border-color:#5a2b30; color:#f0a9a9; }
  button.danger:hover:not(:disabled) { background:#4a2529; }
  button.ghost { background:transparent; border-color:#2a323e; color:#98a2b0; }
  .chip { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; font-weight:700;
          padding:3px 10px; border-radius:999px; background:#1a2334; color:#7f9bd0; }
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
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:10px 18px; }
  @media (max-width:760px){ .grid2{ grid-template-columns:1fr; } }
  .foot { position:fixed; left:0; right:0; bottom:0; background:linear-gradient(180deg,rgba(15,17,21,0),
          #0f1115 42%); padding:18px 26px 20px; }
  .footin { max-width:1080px; margin:0 auto; display:flex; gap:12px; align-items:center; }
  .spacer { flex:1; }
  .tabs { display:flex; gap:6px; margin:0 0 18px; border-bottom:1px solid #232a35; padding-bottom:0; }
  .tab { background:transparent; border:none; border-bottom:2px solid transparent; border-radius:0;
         color:#7d8797; padding:9px 14px; font-weight:700; font-size:13px; cursor:pointer; }
  .tab:hover:not(:disabled) { background:transparent; border-color:transparent; color:#a8b4c4; }
  .tab.active { color:#8aa9ff; border-bottom-color:#3f6bd6; }
`;

export default function App(): React.ReactElement {
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
  const [outcome, setOutcome] = React.useState<Outcome | null>(null);
  const [restored, setRestored] = React.useState<RestoreOutcome | null>(null);
  const [error, setError] = React.useState('');

  const [env, setEnv] = React.useState<{ dbPath: string; hasApiKey: boolean } | null>(null);
  /** 所有引擎的声明式配置（界面据此自适应） */
  const [engines, setEngines] = React.useState<EngineManifestView[]>([]);
  /** 默认翻译方向只从配置应用一次，之后以用户当前选择为准 */
  const appliedDefaults = React.useRef(false);
  /** 页签：汉化（主线闭环）/ 工作台（人工修订） */
  const [tab, setTab] = React.useState<'translate' | 'workbench' | 'settings' | 'logs'>('translate');

  // 订阅一次即可（依赖为空）。返回的取消订阅函数必须在卸载时调用，
  // 否则开发模式热更新会让监听越叠越多 —— 表现为进度条跳动、结果重复。
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
    void api.env().then((r) => {
      if (r.ok && r.data) setEnv({ dbPath: r.data.dbPath, hasApiKey: r.data.hasApiKey });
    });
    void api.engines().then((r) => {
      if (r.ok && Array.isArray(r.data)) setEngines(r.data as EngineManifestView[]);
    });
    // 默认翻译方向来自配置（用户可在配置页改）。
    // ⚠️ 只应用一次：用户在界面上改过之后，不能被配置回读覆盖掉。
    void api.cfgStatus().then((r) => {
      if (r.ok && r.data) {
        const c = r.data as CfgView;
        setEnv({
          dbPath: env?.dbPath ?? '',
          hasApiKey: c.hasApiKey,
        });
        if (!appliedDefaults.current) {
          appliedDefaults.current = true;
          if (c.config.defaultFrom) setFrom(c.config.defaultFrom);
          if (c.config.defaultTo) setTo(c.config.defaultTo);
        }
      }
    });
    return () => {
      offP();
      offF();
    };
  }, [api]);

  /** 选目录 → 立刻识别引擎（"选错目录"要马上告诉用户，而不是等点了开始才报错） */
  const chooseDir = async (): Promise<void> => {
    setError('');
    setOutcome(null);
    setRestored(null);
    const r = await api.pickGameDir();
    if (!r.ok) {
      setError(r.error ?? '选择目录失败');
      return;
    }
    if (!r.data) return; // 用户取消
    setGameDir(r.data);
    setDetecting(true);
    const d = await api.detect(r.data);
    setDetecting(false);
    if (!d.ok || !d.data) {
      setEngine(null);
      setError(d.error ?? '识别失败');
      return;
    }
    setEngine(d.data);
  };

  const start = async (): Promise<void> => {
    if (!gameDir) return;
    setError('');
    setOutcome(null);
    setRestored(null);
    setProgress({ phase: 'extract', current: 0, total: 0, message: '准备中…' });
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
      setError(r.error ?? '启动失败');
      setProgress(null);
      return;
    }
    setRunning(true);
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
    ? Math.round((progress.current / progress.total) * 100)
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
    setRtMsg(`已接管：${d.engine} · ${d.providerName}。游戏里已经在翻；**关闭游戏**即自动还原游戏文件。`);
  };

  const doRuntimeStop = async (): Promise<void> => {
    setRtMsg('正在收尾（结束游戏 + 还原游戏文件）…');
    const r = await api.runtimeStop();
    setRtRunning(false);
    setRtMsg(r.ok ? '已收尾：游戏文件已逐字节还原。' : `收尾失败：${r.error}`);
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
      };
      if (!d.running) {
        setRtRunning(false);
        setRtMsg('游戏已关闭 —— 游戏文件已自动还原。');
        return;
      }
      setRtInfo(d);
    };
    void tick();
    const h = window.setInterval(() => void tick(), 2000);
    return () => {
      stop = true;
      window.clearInterval(h);
    };
  }, [rtRunning]);

  const busy = running || detecting;
  const effectiveProvider = providerId === 'auto'
    ? (env?.hasApiKey ? 'openai（检测到 API Key）' : 'stub 本地假机翻（未检测到 API Key）')
    : providerId;

  return (
    <>
      <style>{css}</style>
      <div className="wrap">
        <div className="kicker">Baibao Box · 主线闭环</div>
        <h1>白的百宝箱</h1>
        <div className="sub">拖进来，点一下，能读了。</div>

        <div className="tabs">
          <button className={`tab${tab === 'translate' ? ' active' : ''}`} onClick={() => setTab('translate')}>
            汉化
          </button>
          <button className={`tab${tab === 'workbench' ? ' active' : ''}`} onClick={() => setTab('workbench')}>
            工作台{engine?.ok ? '' : '（需先选游戏）'}
          </button>
          <button className={`tab${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}>
            配置{env?.hasApiKey ? '' : ' ⚠'}
          </button>
          <button className={`tab${tab === 'logs' ? ' active' : ''}`} onClick={() => setTab('logs')}>
            日志
          </button>
        </div>

        {tab === 'settings' && <Settings />}
        {tab === 'logs' && <Logs />}

        {tab === 'workbench' && <Workbench gameDir={gameDir} />}

        {tab === 'translate' && (<>
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
                <option value="auto">自动（{env?.hasApiKey ? '用 OpenAI' : '用本地假机翻'}）</option>
                <option value="openai">OpenAI 兼容接口</option>
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
              没有检测到 <span className="mono">BAIBAO_OPENAI_API_KEY</span>。
              现在会用**本地假机翻**（译文是 <span className="mono">【中】原文</span>）——
              它只用来验证"抽取 → 入库 → 回写 → 字体 → 还原"整条链路，
              <b>不是真翻译</b>。要看真实效果，请配置密钥后重启。
            </div>
          )}
        </div>

        {/* ── 2.5 一键汉化（运行时）── */}
        <div className="card">
          <h3><span className="step">★</span>一键汉化并启动（运行时 · 推荐）</h3>
          <div className="note">
            启动游戏时把"运行时桥"装进去，<b>边玩边翻</b>：<b>不改游戏数据文件</b>，
            数据被加密的游戏同样有效，<b>关闭游戏即自动逐字节还原</b>。
            译文走上面配置的接口，并本地积累成译文库（第二次启动瞬时且不再花钱）。
            目前支持 RPG Maker MV / MZ。
          </div>
          <div className="row" style={{ marginTop: 14, gap: 10, display: 'flex', alignItems: 'center' }}>
            <button className="primary" disabled={!gameDir || rtRunning} onClick={() => void doRuntimeStart()}>
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
                    本次用的是**本地假机翻**，译文形如 <span className="mono">【中】原文</span>。
                    流程验证有效，但不是真实翻译。
                  </div>
                )}
                {outcome.report.conflicts > 0 && (
                  <div className="warnbox">
                    有 {outcome.report.conflicts} 条译文与控制符占位不一致，**已拒绝写回**（不会破坏游戏）。
                    这些需要人工处理 —— 这正是下一步"人工修订工作台"要解决的。
                  </div>
                )}
                {outcome.report.errors.length > 0 && (
                  <div className="errbox">
                    {outcome.report.errors.map((e, i) => <div key={i}>✗ {e}</div>)}
                  </div>
                )}
                {outcome.report.errors.length === 0 && (
                  <div className="okbox">
                    完成。可以进游戏看看效果；不满意随时用下面的"一键还原"回到翻译前。
                  </div>
                )}
              </>
            )}

            {error && <div className="errbox">{error}</div>}
          </div>
        )}

        </>)}

        {tab === 'translate' && restored && (
          <div className="card">
            <h3>还原结果</h3>
            {restored.nothingToDo
              ? <div className="okbox">没有需要还原的改动（这个游戏还没被我们改过）。</div>
              : <div className="okbox">展开 {restored.patches} 个补丁，还原 {restored.restored} 个文件，已回到翻译前状态。</div>}
            {restored.errors.length > 0 && (
              <div className="errbox">{restored.errors.map((e, i) => <div key={i}>✗ {e}</div>)}</div>
            )}
          </div>
        )}
      </div>

      {/* ── 底部操作条 ── */}
      <div className="foot">
        <div className="footin">
          <button
            className="primary"
            disabled={!gameDir || busy || (engine ? !engine.ok : false)}
            onClick={start}
          >{running ? '汉化中…' : '开始汉化'}</button>
          <button className="danger" disabled={!gameDir || busy} onClick={doRestore}>
            一键还原
          </button>
          <div className="spacer" />
          {running && <span className="muted" style={{ fontSize: 12 }}>正在处理，请勿关闭窗口</span>}
          {busy && !running && <span className="muted" style={{ fontSize: 12 }}>识别中…</span>}
        </div>
      </div>
    </>
  );
}
