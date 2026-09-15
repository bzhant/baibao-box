import React from 'react';

/**
 * 日志页。
 *
 * 为什么必须做：**打包后的应用没有终端**。
 * 之前所有诊断信息都是 `console.log` → 开发期能看，用户拿到的安装包里**看不到**。
 * 用户遇到问题时（没识别出引擎 / 翻译失败 / 回写报错）将完全没有线索，
 * 只能来问"它为什么不动了"。
 *
 * ── 两个设计决定 ──
 *
 * ① **看最新优先**：列表默认显示最近的记录（在最上面），
 *    而不是从头排 —— 排查问题时最新的事件最重要。新记录追加时自动滚到顶部。
 *
 * ② **提供"复制全部"**：用户报问题时，能一次性把上下文贴出来，
 *    比"你截个图"有效得多。日志里的密钥片段已在主进程被打码（见 logbus.ts）。
 */

interface LogRecord {
  seq: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

type Res<T> = { ok: boolean; data?: T; error?: string };

const api = window.baibao;

const LEVEL_LABEL: Record<string, string> = { info: '信息', warn: '警告', error: '错误' };

function hhmmss(t: number): string {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function Logs(): React.ReactElement {
  const [items, setItems] = React.useState<LogRecord[]>([]);
  const [scopes, setScopes] = React.useState<string[]>([]);
  const [level, setLevel] = React.useState('');
  const [scope, setScope] = React.useState('');
  const [auto, setAuto] = React.useState(true);
  const [err, setErr] = React.useState('');
  const [copied, setCopied] = React.useState('');

  const load = React.useCallback(async () => {
    const r = await api.logs({
      limit: 400,
      level: level || undefined,
      scope: scope || undefined,
    }) as Res<{ items: LogRecord[]; scopes: string[] }>;
    if (!r.ok || !r.data) { setErr(r.error ?? '读取日志失败'); return; }
    // 最新在上
    setItems([...r.data.items].reverse());
    setScopes(r.data.scopes);
  }, [level, scope]);

  React.useEffect(() => { void load(); }, [load]);

  // 自动刷新：翻译是长任务，用户会一边跑一边看日志。
  // 只在开关打开时轮询（关掉可避免不必要的主进程往返）。
  React.useEffect(() => {
    if (!auto) return;
    const t = setInterval(() => { void load(); }, 2000);
    return () => clearInterval(t);
  }, [auto, load]);

  const copyAll = async (): Promise<void> => {
    const text = items
      .slice()
      .reverse()
      .map((r) => `[${hhmmss(r.time)}][${r.level}][${r.scope}] ${r.message}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(`已复制 ${items.length} 条`);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('复制失败（剪贴板不可用）');
      setTimeout(() => setCopied(''), 2000);
    }
  };

  const color = (lv: string): string =>
    lv === 'error' ? '#e4878d' : lv === 'warn' ? '#e0b45c' : '#8b95a4';
  const counts = {
    error: items.filter((r) => r.level === 'error').length,
    warn: items.filter((r) => r.level === 'warn').length,
    info: items.filter((r) => r.level === 'info').length,
  };

  return (
    <>
      <div className="card">
        <h3>筛选</h3>
        <div className="row" style={{ marginBottom: 12 }}>
          <span className="chip">共 {items.length} 条</span>
          <span className="chip err">错误 {counts.error}</span>
          <span className="chip warn">警告 {counts.warn}</span>
          <span className="chip ok">信息 {counts.info}</span>
        </div>
        <div className="row">
          <div className="field">
            <label>级别</label>
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="">全部</option>
              <option value="warn">警告及以上</option>
              <option value="error">只看错误</option>
            </select>
          </div>
          <div className="field">
            <label>类别</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">全部</option>
              {scopes.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <label className="note" style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer', marginTop: 16 }}>
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            自动刷新（2 秒）
          </label>
          <div className="spacer" />
          <button className="ghost" onClick={() => void load()}>刷新</button>
          <button className="ghost" onClick={() => void copyAll()} disabled={!items.length}>复制全部</button>
          <button className="danger" onClick={() => void (async () => {
            await api.logsClear();
            await load();
          })()}>清空</button>
        </div>
        {copied && <div className="okbox" style={{ marginTop: 10 }}>{copied}</div>}
        {err && <div className="errbox" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      <div className="card">
        <h3>
          日志 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
            {items.length} 条（最新在上）
          </span>
        </h3>
        {items.length === 0 ? (
          <div className="emptyState">
            <div>
              <h4>这里会保留最近的运行轨迹</h4>
              <p>
                选一次游戏目录、跑一次汉化，或者点一次接口测试，日志就会开始积累。
                打包后的应用没有终端，这里就是排查问题时最完整的上下文。
              </p>
              <div className="emptyTips">
                <span className="chip">先去「汉化」页选游戏</span>
                <span className="chip">或在「配置」页测试接口</span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{
            maxHeight: 460, overflow: 'auto', background: '#0f1319',
            border: '1px solid #2a323e', borderRadius: 9, padding: '10px 12px',
          }}>
            {items.map((r) => (
              <div key={r.seq} className="mono" style={{ fontSize: 11.5, lineHeight: 1.85, display: 'flex', gap: 8 }}>
                <span style={{ color: '#5f6b7c', flexShrink: 0 }}>{hhmmss(r.time)}</span>
                <span style={{ color: color(r.level), flexShrink: 0, width: 30 }}>
                  {LEVEL_LABEL[r.level]}
                </span>
                <span style={{ color: '#7f9bd0', flexShrink: 0, width: 64 }}>{r.scope}</span>
                <span style={{ color: '#c3cbd6', wordBreak: 'break-all' }}>{r.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
