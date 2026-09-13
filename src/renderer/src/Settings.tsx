import React from 'react';

/**
 * 配置页。
 *
 * 为什么需要它：在此之前所有可配置项都只能靠**环境变量**。
 * 那对命令行很自然，但**打包后的图形界面用户根本没法填** ——
 * 连"填个 API Key"都要改环境变量，这是最扎眼的缺口。
 *
 * ── 两个刻意的设计 ──
 *
 * ① **密钥只进不出**：这个页面只能"写入/清除"密钥，
 *    读不到已保存的值（只能知道"有没有配""是否加密"）。
 *    否则渲染层一旦被注入脚本，密钥就等于泄露 —— contextIsolation 也就白做了。
 *
 * ② **加密状态如实显示**：`safeStorage` 不可用时会降级为明文存储，
 *    这时界面必须**明确警告**，而不是让用户以为"已经安全了"。
 */

interface Cfg {
  openaiBaseUrl: string;
  openaiModel: string;
  defaultFrom: string;
  defaultTo: string;
  batchSize: number;
  concurrency: number;
  backupBeforeRepack: boolean;
}

type Res<T> = { ok: boolean; data?: T; error?: string };

const api = window.baibao;

export default function Settings(): React.ReactElement {
  const [status, setStatus] = React.useState<{
    hasApiKey: boolean; secretEncrypted: boolean; path: string; config: Cfg;
  } | null>(null);
  const [draft, setDraft] = React.useState<Cfg | null>(null);
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [err, setErr] = React.useState('');

  const load = React.useCallback(async () => {
    const r = await api.cfgStatus() as Res<typeof status>;
    if (!r.ok || !r.data) { setErr(r.error ?? '读取配置失败'); return; }
    setStatus(r.data);
    setDraft(r.data.config);
  }, []);

  React.useEffect(() => { void load(); }, [load]);

  const savePrefs = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true); setErr(''); setMsg('');
    const r = await api.cfgUpdate(draft as unknown as Record<string, unknown>);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '保存失败'); return; }
    setMsg('已保存。');
    await load();
  };

  const saveKey = async (clear = false): Promise<void> => {
    setBusy(true); setErr(''); setMsg('');
    const r = await api.cfgSetKey(clear ? '' : key);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '保存密钥失败'); return; }
    if (clear) {
      setMsg('已清除 API Key，将回退到本地假机翻。');
    } else if (r.data?.encrypted) {
      setMsg('已保存 API Key（已用系统密钥加密存储）。');
    } else {
      setMsg('已保存 API Key。⚠ 当前系统不支持加密存储，密钥以明文保存在配置文件里。');
    }
    setKey('');
    await load();
  };

  if (!status || !draft) {
    return <div className="card"><div className="note">{err || '读取配置中…'}</div></div>;
  }

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]): void =>
    setDraft({ ...draft, [k]: v });

  return (
    <>
      <div className="card">
        <h3>翻译引擎（API Key）</h3>
        <div className="row">
          {status.hasApiKey
            ? <span className="chip ok">已配置</span>
            : <span className="chip warn">未配置 —— 现在只能用本地假机翻</span>}
          {status.hasApiKey && (
            status.secretEncrypted
              ? <span className="chip ok">已加密存储</span>
              : <span className="chip err">⚠ 明文存储</span>
          )}
        </div>

        {status.hasApiKey && !status.secretEncrypted && (
          <div className="warnbox">
            当前系统的安全存储不可用，密钥以**明文**写在 <span className="mono">config.json</span> 里。
            任何能读到该文件的程序都能拿走它 —— 请知悉。
          </div>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <div className="field" style={{ flex: 1, minWidth: 320 }}>
            <label>API Key（留空则不修改；保存后界面上读不回来）</label>
            <input
              type="text" value={key} placeholder="sk-..." disabled={busy}
              onChange={(e) => setKey(e.target.value)}
            />
          </div>
          <button className="primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
            保存密钥
          </button>
          <button className="danger" disabled={busy || !status.hasApiKey} onClick={() => void saveKey(true)}>
            清除
          </button>
        </div>
        <div className="note" style={{ marginTop: 8 }}>
          界面上**永远读不回**已保存的密钥，只能覆盖或清除。
        </div>
      </div>

      <div className="card">
        <h3>接口参数</h3>
        <div className="grid2">
          <div className="field">
            <label>接口地址（OpenAI 兼容端点）</label>
            <input type="text" value={draft.openaiBaseUrl} disabled={busy}
              onChange={(e) => set('openaiBaseUrl', e.target.value)} />
          </div>
          <div className="field">
            <label>模型</label>
            <input type="text" value={draft.openaiModel} disabled={busy}
              onChange={(e) => set('openaiModel', e.target.value)} />
          </div>
          <div className="field">
            <label>批大小（每次送多少条给翻译）</label>
            <input type="number" min={1} value={draft.batchSize} disabled={busy}
              onChange={(e) => set('batchSize', Number(e.target.value) || 1)} />
          </div>
          <div className="field">
            <label>并发上限</label>
            <input type="number" min={1} value={draft.concurrency} disabled={busy}
              onChange={(e) => set('concurrency', Number(e.target.value) || 1)} />
          </div>
        </div>
        <div className="note" style={{ marginTop: 10 }}>
          本地模型 / 中转站通常也兼容这个接口，把地址指过去即可。
        </div>
      </div>

      <div className="card">
        <h3>默认设置</h3>
        <div className="grid2">
          <div className="field">
            <label>默认源语言</label>
            <select value={draft.defaultFrom} disabled={busy}
              onChange={(e) => set('defaultFrom', e.target.value)}>
              <option value="ja">日语 ja</option>
              <option value="en">英语 en</option>
              <option value="ko">韩语 ko</option>
            </select>
          </div>
          <div className="field">
            <label>默认目标语言</label>
            <select value={draft.defaultTo} disabled={busy}
              onChange={(e) => set('defaultTo', e.target.value)}>
              <option value="zh-CN">简体中文 zh-CN</option>
              <option value="zh-TW">繁體中文 zh-TW</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <label className="note" style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={draft.backupBeforeRepack} disabled={busy}
              onChange={(e) => set('backupBeforeRepack', e.target.checked)} />
            回写前自动备份
          </label>
        </div>
        <div className="note" style={{ marginTop: 6 }}>
          <span className="muted">
            （关掉就失去了"一键还原"的能力 —— 工程上不建议，出问题时无法回溯。）
          </span>
        </div>
      </div>

      <div className="card">
        <h3>配置文件</h3>
        <div className="row">
          <span className="mono" style={{ fontSize: 12 }}>{status.path}</span>
          <div className="spacer" />
          <button className="ghost" onClick={() => void api.reveal(status.path)}>打开所在目录</button>
        </div>
      </div>

      {(msg || err) && (
        <div className="card">
          {msg && <div className="okbox">{msg}</div>}
          {err && <div className="errbox">{err}</div>}
        </div>
      )}

      <div className="foot">
        <div className="footin">
          <button className="primary" disabled={busy} onClick={() => void savePrefs()}>保存设置</button>
          <button className="ghost" disabled={busy} onClick={() => void load()}>放弃修改</button>
        </div>
      </div>
    </>
  );
}
