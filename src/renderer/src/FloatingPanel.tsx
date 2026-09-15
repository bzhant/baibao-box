import React from 'react';
import {
  ChevronRight,
  ExternalLink,
  Gamepad2,
  Languages,
  Minus,
  Play,
  RotateCcw,
  Square,
} from 'lucide-react';

interface IpcResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface Progress {
  phase: 'extract' | 'store' | 'tm' | 'translate' | 'repack' | 'font' | 'done';
  current: number;
  total: number;
  message?: string;
}

interface EngineInfo {
  ok: boolean;
  engineId?: string;
  engineName?: string;
  encrypted: boolean;
  gameId: string;
  message?: string;
}

interface RuntimeInfo {
  running?: boolean;
  stopping?: boolean;
  requested?: number;
  localHits?: number;
}

interface ConfigInfo {
  activeProfile?: { name: string };
  config: { defaultFrom: string; defaultTo: string };
}

interface FloatingApi {
  pickGameDir(): Promise<IpcResult<string | null>>;
  detect(dir: string): Promise<IpcResult<EngineInfo>>;
  env(): Promise<IpcResult<{ hasApiKey: boolean; translating: boolean }>>;
  cfgStatus(): Promise<IpcResult<unknown>>;
  runtimeStatus(): Promise<IpcResult<unknown>>;
  runtimeStart(gameDir: string): Promise<IpcResult<unknown>>;
  runtimeStop(): Promise<IpcResult<unknown>>;
  startTranslate(opts: Record<string, unknown>): Promise<IpcResult<{ started: true }>>;
  cancelTranslate(): Promise<IpcResult<{ cancelled: boolean }>>;
  restore(gameDir: string): Promise<IpcResult<{
    restored: number;
    errors: string[];
    nothingToDo: boolean;
  }>>;
  floatingStatus(): Promise<IpcResult<{ open: boolean; expanded: boolean }>>;
  floatingSetExpanded(expanded: boolean): Promise<IpcResult<{ open: boolean; expanded: boolean }>>;
  floatingSetPosition(x: number, y: number): Promise<IpcResult<{ moved: boolean }>>;
  showMainWindow(): Promise<IpcResult<{ shown: true }>>;
  onProgress(cb: (event: Progress) => void): () => void;
  onFinished(cb: (result: IpcResult<unknown>) => void): () => void;
}

const LAST_GAME_DIR_KEY = 'baibao:floating:last-game-dir';

const PHASE_LABEL: Record<Progress['phase'], string> = {
  extract: '抽取',
  store: '入库',
  tm: '记忆库',
  translate: '翻译',
  repack: '回写',
  font: '字体',
  done: '完成',
};

function readGameDir(): string {
  try {
    return window.localStorage.getItem(LAST_GAME_DIR_KEY) ?? '';
  } catch {
    return '';
  }
}

function gameName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export default function FloatingPanel(): React.ReactElement {
  const api = window.baibao as unknown as FloatingApi;
  const [expanded, setExpanded] = React.useState(false);
  const [gameDir, setGameDir] = React.useState(readGameDir);
  const [engine, setEngine] = React.useState<EngineInfo | null>(null);
  const [config, setConfig] = React.useState<ConfigInfo | null>(null);
  const [hasApiKey, setHasApiKey] = React.useState(false);
  const [translating, setTranslating] = React.useState(false);
  const [runtime, setRuntime] = React.useState<RuntimeInfo | null>(null);
  const [progress, setProgress] = React.useState<Progress | null>(null);
  const [message, setMessage] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const detectRequest = React.useRef(0);
  const dragGesture = React.useRef<{
    pointerId: number;
    startScreenX: number;
    startScreenY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);

  const refresh = React.useCallback(async (): Promise<void> => {
    const [envResult, runtimeResult, configResult, floatingResult] = await Promise.all([
      api.env(),
      api.runtimeStatus(),
      api.cfgStatus(),
      api.floatingStatus(),
    ]);
    if (envResult.ok && envResult.data) {
      setTranslating(envResult.data.translating);
      setHasApiKey(envResult.data.hasApiKey);
    }
    if (runtimeResult.ok && runtimeResult.data) setRuntime(runtimeResult.data as RuntimeInfo);
    if (configResult.ok && configResult.data) setConfig(configResult.data as ConfigInfo);
    if (floatingResult.ok && floatingResult.data) setExpanded(floatingResult.data.expanded);
  }, [api]);

  const detect = React.useCallback(async (dir: string, announce = false): Promise<void> => {
    const request = ++detectRequest.current;
    setBusy(true);
    try {
      const result = await api.detect(dir);
      if (request !== detectRequest.current) return;
      if (!result.ok || !result.data) {
        setEngine(null);
        setMessage(result.error ?? '未识别出游戏引擎');
        return;
      }
      setEngine(result.data);
      if (announce) {
        setMessage(result.data.ok
          ? `已识别 ${result.data.engineName ?? '游戏引擎'}`
          : (result.data.message ?? '未识别出游戏引擎'));
      }
    } catch (error) {
      if (request !== detectRequest.current) return;
      setEngine(null);
      setMessage((error as Error).message || '识别游戏引擎失败');
    } finally {
      if (request === detectRequest.current) setBusy(false);
    }
  }, [api]);

  React.useEffect(() => {
    void refresh();
    const offProgress = api.onProgress((event) => setProgress(event));
    const offFinished = api.onFinished((result) => {
      setMessage(result.ok ? '静态汉化完成' : (result.error ?? '静态汉化失败'));
      void refresh();
    });
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      offProgress();
      offFinished();
      window.clearInterval(timer);
    };
  }, [api, refresh]);

  React.useEffect(() => {
    if (gameDir) void detect(gameDir, true);
  }, [detect, gameDir]);

  React.useLayoutEffect(() => {
    document.body.classList.toggle('floating-expanded', expanded);
    return () => document.body.classList.remove('floating-expanded');
  }, [expanded]);

  const toggleExpanded = async (): Promise<void> => {
    const target = !expanded;
    const result = await api.floatingSetExpanded(target);
    if (result.ok && result.data) setExpanded(result.data.expanded);
  };

  const beginWindowGesture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragGesture.current = {
      pointerId: event.pointerId,
      startScreenX: event.screenX,
      startScreenY: event.screenY,
      offsetX: event.clientX,
      offsetY: event.clientY,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveWindowGesture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.screenX - gesture.startScreenX,
      event.screenY - gesture.startScreenY,
    );
    if (!gesture.moved && distance < 3) return;
    gesture.moved = true;
    void api.floatingSetPosition(
      event.screenX - gesture.offsetX,
      event.screenY - gesture.offsetY,
    );
  };

  const endWindowGesture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const gesture = dragGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragGesture.current = null;
    if (!gesture.moved) void toggleExpanded();
  };

  const cancelWindowGesture = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (dragGesture.current?.pointerId !== event.pointerId) return;
    dragGesture.current = null;
  };

  const toggleFromKeyboard = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.detail === 0) void toggleExpanded();
  };

  const chooseGame = async (): Promise<void> => {
    const result = await api.pickGameDir();
    if (!result.ok) {
      setMessage(result.error ?? '选择目录失败');
      return;
    }
    if (!result.data) return;
    setGameDir(result.data);
    try {
      window.localStorage.setItem(LAST_GAME_DIR_KEY, result.data);
    } catch {
      // 当前会话仍可继续使用。
    }
  };

  const toggleRuntime = async (): Promise<void> => {
    if (!gameDir) return;
    setBusy(true);
    const result = runtime?.running
      ? await api.runtimeStop()
      : await api.runtimeStart(gameDir);
    setBusy(false);
    setMessage(result.ok
      ? (runtime?.running ? '已结束并还原' : '游戏已启动')
      : (result.error ?? '运行时操作失败'));
    await refresh();
  };

  const toggleStatic = async (): Promise<void> => {
    if (!gameDir) return;
    setBusy(true);
    const result = translating
      ? await api.cancelTranslate()
      : await api.startTranslate({
          gameDir,
          from: config?.config.defaultFrom,
          to: config?.config.defaultTo,
          repack: true,
          injectFont: true,
        });
    setBusy(false);
    setMessage(result.ok
      ? (translating ? '正在取消任务' : '静态汉化已开始')
      : (result.error ?? '静态汉化操作失败'));
    await refresh();
  };

  const restore = async (): Promise<void> => {
    if (!gameDir) return;
    if (!window.confirm(`确定还原 ${gameName(gameDir)} 的静态改动吗？`)) return;
    setBusy(true);
    const result = await api.restore(gameDir);
    setBusy(false);
    if (!result.ok || !result.data) {
      setMessage(result.error ?? '还原失败');
      return;
    }
    setMessage(result.data.nothingToDo
      ? '没有需要还原的改动'
      : result.data.errors.length > 0
        ? `已恢复 ${result.data.restored} 个文件，仍有错误`
        : `已恢复 ${result.data.restored} 个文件`);
  };

  const active = translating || !!runtime?.running || !!runtime?.stopping;
  const gameReady = !!gameDir && !!engine?.ok;
  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.current / progress.total * 100))
    : 0;
  const statusText = runtime?.stopping
    ? '正在还原游戏文件'
    : runtime?.running
      ? `运行时 · 取词 ${runtime.requested ?? 0} · 命中 ${runtime.localHits ?? 0}`
      : translating
        ? `${progress ? PHASE_LABEL[progress.phase] : '静态汉化'}${progress?.total ? ` ${progress.current}/${progress.total}` : ''}`
        : message || '空闲';

  if (!expanded) {
    return (
      <div className={`floatingOrbShell${active ? ' active' : ''}`} title="拖动外圈，点击中心展开">
        <button
          className="floatingOrb"
          title="展开白的百宝箱"
          aria-label="展开悬浮窗"
          onPointerDown={beginWindowGesture}
          onPointerMove={moveWindowGesture}
          onPointerUp={endWindowGesture}
          onPointerCancel={cancelWindowGesture}
          onClick={toggleFromKeyboard}
        >
          <span className="floatingOrbMark">白</span>
          <span className={`floatingOrbDot${active ? ' active' : ''}`} />
        </button>
      </div>
    );
  }

  return (
    <div className={`floatingController${active ? ' active' : ''}`}>
      <header className="floatingControllerHeader">
        <button
          className="floatingControllerLogo"
          title="折叠为悬浮球"
          aria-label="折叠悬浮窗"
          onPointerDown={beginWindowGesture}
          onPointerMove={moveWindowGesture}
          onPointerUp={endWindowGesture}
          onPointerCancel={cancelWindowGesture}
          onClick={toggleFromKeyboard}
        >
          白
        </button>
        <div className="floatingControllerHeading">
          <strong>百宝箱</strong>
          <span className={active ? 'active' : ''}>
            <i />
            {active ? '任务执行中' : '快捷控制'}
          </span>
        </div>
        <div className="floatingWindowActions">
          <button onClick={() => void toggleExpanded()} title="折叠为悬浮球" aria-label="折叠">
            <Minus size={15} strokeWidth={2} />
          </button>
          <button onClick={() => void api.showMainWindow()} title="返回主窗口" aria-label="返回主窗口">
            <ExternalLink size={14} strokeWidth={2} />
          </button>
        </div>
      </header>

      <div className="floatingCommandSurface">
        <button className="floatingGameSelector" onClick={() => void chooseGame()} disabled={busy}>
          <span className={`floatingGameGlyph${engine?.ok ? ' ready' : ''}`}>
            <Gamepad2 size={17} strokeWidth={1.9} />
          </span>
          <span className="floatingGameText">
            <strong>{gameDir ? gameName(gameDir) : '选择游戏目录'}</strong>
            <small>{engine?.engineName ?? (gameDir ? '重新选择目标' : '设置本次操作目标')}</small>
          </span>
          <ChevronRight className="floatingArrow" size={16} strokeWidth={1.8} />
        </button>

        <div className="floatingQuickActions">
          <button
            className={`floatingQuickButton runtime${runtime?.running ? ' running' : ''}`}
            disabled={!gameReady || translating || busy}
            onClick={() => void toggleRuntime()}
          >
            <span className="floatingActionIcon">
              {runtime?.running
                ? <Square size={15} fill="currentColor" strokeWidth={1.5} />
                : <Play size={16} fill="currentColor" strokeWidth={1.5} />}
            </span>
            <span className="floatingActionCopy">
              <strong>{runtime?.running ? '结束运行' : '启动游戏'}</strong>
              <small>{runtime?.running ? '并还原文件' : '运行时汉化'}</small>
            </span>
          </button>
          <button
            className={`floatingQuickButton static${translating ? ' running' : ''}`}
            disabled={!gameReady || !!runtime?.running || busy || !!engine?.encrypted}
            onClick={() => void toggleStatic()}
          >
            <span className="floatingActionIcon">
              {translating
                ? <Square size={15} fill="currentColor" strokeWidth={1.5} />
                : <Languages size={17} strokeWidth={1.8} />}
            </span>
            <span className="floatingActionCopy">
              <strong>{translating ? '取消任务' : '写入汉化'}</strong>
              <small>{translating ? '保留已有进度' : '静态处理'}</small>
            </span>
          </button>
        </div>
      </div>

      <footer className={`floatingControllerStatus${active ? ' active' : ''}`}>
        <div className="floatingStatusLine">
          <span className="floatingStatusDot" />
          <span title={statusText}>{statusText}</span>
        </div>
        <div className="floatingStatusTools">
          <span className={hasApiKey ? 'ready' : ''} title={config?.activeProfile?.name ?? '未读取方案'}>
            <i />
            {config?.activeProfile?.name ?? '未配置方案'}
          </span>
          <button
            disabled={!gameDir || active || busy}
            onClick={() => void restore()}
            title="还原静态改动"
            aria-label="还原静态改动"
          >
            <RotateCcw size={14} strokeWidth={2} />
          </button>
        </div>
        {translating && <div className="floatingProgress"><i style={{ width: `${pct}%` }} /></div>}
      </footer>
    </div>
  );
}
