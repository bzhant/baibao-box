import React from 'react';

/**
 * 配置页。
 *
 * 为什么需要它：在此之前所有可配置项都只能靠**环境变量**。
 * 那对命令行很自然，但**打包后的图形界面用户根本没法填** ——
 * 连"填个 API Key"都要改环境变量，这是最扎眼的缺口。
 *
 * ── 三个刻意的设计 ──
 *
 * ① **密钥只进不出**：这个页面只能"写入/清除"密钥，
 *    读不到已保存的值（只能知道"有没有配""是否加密"）。
 *    否则渲染层一旦被注入脚本，密钥就等于泄露 —— contextIsolation 也就白做了。
 *
 * ② **加密状态如实显示**：`safeStorage` 不可用时会降级为明文存储，
 *    这时界面必须**明确警告**，而不是让用户以为"已经安全了"。
 *
 * ③ **接口方案可以存多套**（DeepSeek / OpenAI / 本地 Ollama / 中转站……）：
 *    不同游戏的文本量、语言对不同，"哪家便宜用哪家"是很实际的需求；
 *    每套方案**各存各的密钥**，换方案不用把密钥重新粘一遍。
 *    预置清单由主进程送来（渲染层不 import 平台层代码，保持边界）。
 */

interface ProfileView {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  preset: string;
  hasKey: boolean;
  encrypted: boolean;
  isActive: boolean;
}

interface PresetView {
  preset: string;
  name: string;
  baseUrl: string;
  model: string;
  note: string;
}

interface Cfg {
  activeProfileId: string;
  defaultFrom: string;
  defaultTo: string;
  batchSize: number;
  concurrency: number;
  backupBeforeRepack: boolean;
}

interface Status {
  hasApiKey: boolean;
  secretEncrypted: boolean;
  path: string;
  config: Cfg;
  profiles: ProfileView[];
  activeProfile: { id: string; name: string };
  presets: PresetView[];
}

type Res<T> = { ok: boolean; data?: T; error?: string };

const api = window.baibao;

export default function Settings(): React.ReactElement {
  const [status, setStatus] = React.useState<Status | null>(null);
  const [draft, setDraft] = React.useState<Cfg | null>(null);
  const [profiles, setProfiles] = React.useState<ProfileView[]>([]);
  const [presets, setPresets] = React.useState<PresetView[]>([]);

  /** 正在编辑的方案 id，以及它的未保存改动（点"保存方案"才落盘） */
  const [editId, setEditId] = React.useState('');
  const [pDraft, setPDraft] = React.useState<{ name: string; baseUrl: string; model: string } | null>(null);
  const [key, setKey] = React.useState('');
  const [showNew, setShowNew] = React.useState(false);
  const [test, setTest] = React.useState<{ ok: boolean; detail: string; ms: number } | null>(null);

  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [err, setErr] = React.useState('');

  const load = React.useCallback(async (): Promise<void> => {
    const r = (await api.cfgStatus()) as Res<Status>;
    if (!r.ok || !r.data) {
      setErr(r.error ?? '读取配置失败');
      return;
    }
    setStatus(r.data);
    setDraft(r.data.config);
    setProfiles(r.data.profiles);
    setPresets(r.data.presets ?? []);
    // 默认把当前启用的方案摊开编辑（最常见的就是"改一下正在用的那套"）
    const cur = r.data.profiles.find((p) => p.isActive) ?? r.data.profiles[0];
    if (cur) {
      setEditId(cur.id);
      setPDraft({ name: cur.name, baseUrl: cur.baseUrl, model: cur.model });
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const flash = (m: string): void => {
    setMsg(m);
    setErr('');
  };

  // ── 方案 ──────────────────────────────────────────────────────

  const selectProfile = (p: ProfileView): void => {
    setEditId(p.id);
    setPDraft({ name: p.name, baseUrl: p.baseUrl, model: p.model });
    setKey('');
    setTest(null);
    setMsg('');
    setErr('');
  };

  const activate = async (id: string): Promise<void> => {
    setBusy(true);
    const r = (await api.cfgProfileActivate(id)) as Res<unknown>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '切换失败');
      return;
    }
    flash('已切换当前使用的接口方案。');
    await load();
  };

  const addFromPreset = async (preset: PresetView): Promise<void> => {
    setBusy(true);
    const r = (await api.cfgProfileSave({
      preset: preset.preset,
      name: preset.name,
      baseUrl: preset.baseUrl,
      model: preset.model,
    })) as Res<unknown>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '新增失败');
      return;
    }
    setShowNew(false);
    flash(`已新增方案「${preset.name}」——填一把密钥就能用。`);
    await load();
  };

  const saveProfileNow = async (): Promise<void> => {
    if (!pDraft) return;
    setBusy(true);
    setErr('');
    setMsg('');
    const cur = profiles.find((p) => p.id === editId);
    const r = (await api.cfgProfileSave({
      id: editId,
      preset: cur?.preset ?? 'custom',
      ...pDraft,
    })) as Res<unknown>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '保存方案失败');
      return;
    }
    flash('方案已保存。');
    await load();
  };

  const removeProfile = async (p: ProfileView): Promise<void> => {
    if (!window.confirm(`删除方案「${p.name}」？（它保存的密钥也会一起删掉）`)) return;
    setBusy(true);
    const r = (await api.cfgProfileDelete(p.id)) as Res<unknown>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '删除失败');
      return;
    }
    flash('已删除该方案。');
    await load();
  };

  const saveKey = async (id: string, clear = false): Promise<void> => {
    setBusy(true);
    setErr('');
    setMsg('');
    const r = (await api.cfgSetKey(id, clear ? '' : key)) as Res<{ encrypted: boolean }>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '保存密钥失败');
      return;
    }
    if (clear) flash('已清除这套方案的密钥。');
    else if (r.data?.encrypted) flash('已保存密钥（已用系统密钥加密存储）。');
    else flash('已保存密钥。⚠ 当前系统不支持加密存储，密钥以明文保存在配置文件里。');
    setKey('');
    await load();
  };

  const testConn = async (id: string): Promise<void> => {
    setBusy(true);
    setTest(null);
    setErr('');
    setMsg('');
    const r = (await api.cfgProfileTest(id)) as Res<{ ok: boolean; detail: string; ms: number }>;
    setBusy(false);
    if (!r.ok || !r.data) {
      setErr(r.error ?? '测试失败');
      return;
    }
    setTest(r.data);
  };

  // ── 标量偏好 ──────────────────────────────────────────────────

  const savePrefs = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setErr('');
    setMsg('');
    const r = (await api.cfgUpdate(draft as unknown as Record<string, unknown>)) as Res<unknown>;
    setBusy(false);
    if (!r.ok) {
      setErr(r.error ?? '保存失败');
      return;
    }
    flash('已保存。');
    await load();
  };

  if (!status || !draft) {
    return (
      <div className="card">
        <div className="note">{err || '读取配置中…'}</div>
      </div>
    );
  }

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]): void => setDraft({ ...draft, [k]: v });
  const editing = profiles.find((p) => p.id === editId) ?? null;
  const active = profiles.find((p) => p.isActive) ?? null;

  return (
    <>
      {/* ── 接口方案（多套） ── */}
      <div className="card">
        <h3>翻译接口方案</h3>
        <div className="note">
          可以存多套接口（DeepSeek / OpenAI / 本地 Ollama / 中转站……）随时切换。
          <b>每套各存各的密钥</b> —— 换方案不用重新粘一遍。当前启用：
          <b style={{ color: '#a8b4c4' }}>{active ? active.name : '（无）'}</b>
        </div>

        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap', gap: 8 }}>
          {profiles.map((p) => (
            <span key={p.id} className="row" style={{ gap: 6, alignItems: 'center' }}>
              <button
                className={p.isActive ? 'primary' : ''}
                disabled={busy}
                title={p.isActive ? '当前启用' : '点一下切换为启用'}
                onClick={() => void activate(p.id)}
              >
                {p.isActive ? '● ' : '○ '}
                {p.name}
                {p.hasKey ? '' : '（未填密钥）'}
              </button>
              <button
                className="ghost"
                disabled={busy}
                title="编辑这套方案"
                onClick={() => selectProfile(p)}
              >
                编辑
              </button>
            </span>
          ))}
          <button className="ghost" disabled={busy} onClick={() => setShowNew(!showNew)}>
            {showNew ? '收起' : '+ 新增方案'}
          </button>
        </div>

        {showNew && (
          <div style={{ marginTop: 10 }}>
            <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
              {presets.map((x) => (
                <button key={x.preset} className="ghost" disabled={busy} onClick={() => void addFromPreset(x)}>
                  + {x.name}
                </button>
              ))}
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              {presets.map((x) => (
                <div key={x.preset}>
                  · <b>{x.name}</b>
                  {x.baseUrl ? <span className="mono"> {x.baseUrl}</span> : null} — {x.note}
                </div>
              ))}
            </div>
          </div>
        )}

        {editing && pDraft && (
          <div style={{ marginTop: 14, borderTop: '1px solid #2a323e', paddingTop: 12 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="chip">正在编辑：{editing.name}</span>
              {editing.hasKey ? (
                editing.encrypted ? (
                  <span className="chip ok">已配置密钥（已加密）</span>
                ) : (
                  <span className="chip err">密钥为明文存储</span>
                )
              ) : (
                <span className="chip warn">未配置密钥</span>
              )}
              <div className="spacer" />
              <button className="danger" disabled={busy || profiles.length <= 1} onClick={() => void removeProfile(editing)}>
                删除这套
              </button>
            </div>

            <div className="grid2" style={{ marginTop: 12 }}>
              <div className="field">
                <label>方案名（自己认得就行）</label>
                <input
                  type="text"
                  value={pDraft.name}
                  disabled={busy}
                  onChange={(e) => setPDraft({ ...pDraft, name: e.target.value })}
                />
              </div>
              <div className="field">
                <label>接口地址（OpenAI 兼容端点，不带 /chat/completions）</label>
                <input
                  type="text"
                  value={pDraft.baseUrl}
                  placeholder="https://api.deepseek.com/v1"
                  disabled={busy}
                  onChange={(e) => setPDraft({ ...pDraft, baseUrl: e.target.value })}
                />
              </div>
              <div className="field">
                <label>模型</label>
                <input
                  type="text"
                  value={pDraft.model}
                  placeholder="deepseek-chat"
                  disabled={busy}
                  onChange={(e) => setPDraft({ ...pDraft, model: e.target.value })}
                />
              </div>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="ghost" disabled={busy} onClick={() => void saveProfileNow()}>
                保存方案
              </button>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <div className="field" style={{ flex: 1, minWidth: 320 }}>
                <label>API Key（留空则不修改；保存后界面上读不回来）</label>
                <input
                  type="text"
                  value={key}
                  placeholder="sk-..."
                  disabled={busy}
                  onChange={(e) => setKey(e.target.value)}
                />
              </div>
              <button className="primary" disabled={busy || !key.trim()} onClick={() => void saveKey(editing.id)}>
                保存密钥
              </button>
              <button className="ghost" disabled={busy || !editing.hasKey} onClick={() => void saveKey(editing.id, true)}>
                清除
              </button>
              <button className="ghost" disabled={busy} onClick={() => void testConn(editing.id)}>
                测试连接
              </button>
            </div>
            <div className="note" style={{ marginTop: 8 }}>
              界面上**永远读不回**已保存的密钥，只能覆盖或清除。
              「测试连接」会**真发一句**（こんにちは）去试 —— 比"看有没有填密钥"可靠：
              地址写错、模型名不存在、余额不足，都能在这里当场发现，而不是翻到一半才炸。
            </div>
            {test && (
              <div className={test.ok ? 'okbox' : 'errbox'} style={{ marginTop: 10 }}>
                {test.ok ? '✓ ' : '✗ '}
                {test.detail}
                <span className="muted">（{test.ms} ms）</span>
              </div>
            )}
          </div>
        )}

        {status.hasApiKey && !status.secretEncrypted && (
          <div className="warnbox" style={{ marginTop: 12 }}>
            当前系统的安全存储不可用，密钥以**明文**写在 <span className="mono">config.json</span> 里。
            任何能读到该文件的程序都能拿走它 —— 请知悉。
          </div>
        )}
      </div>

      {/* ── 通用参数 ── */}
      <div className="card">
        <h3>翻译参数</h3>
        <div className="grid2">
          <div className="field">
            <label>批大小（每次送多少条给翻译）</label>
            <input
              type="number"
              min={1}
              value={draft.batchSize}
              disabled={busy}
              onChange={(e) => set('batchSize', Number(e.target.value) || 1)}
            />
          </div>
          <div className="field">
            <label>并发上限</label>
            <input
              type="number"
              min={1}
              value={draft.concurrency}
              disabled={busy}
              onChange={(e) => set('concurrency', Number(e.target.value) || 1)}
            />
          </div>
        </div>
        <div className="note" style={{ marginTop: 10 }}>
          本地模型 / 中转站通常也兼容这个接口：在方案里把地址指过去即可。
        </div>
      </div>

      {/* ── 默认设置 ── */}
      <div className="card">
        <h3>默认设置</h3>
        <div className="grid2">
          <div className="field">
            <label>默认源语言</label>
            <select value={draft.defaultFrom} disabled={busy} onChange={(e) => set('defaultFrom', e.target.value)}>
              <option value="ja">日语 ja</option>
              <option value="en">英语 en</option>
              <option value="ko">韩语 ko</option>
            </select>
          </div>
          <div className="field">
            <label>默认目标语言</label>
            <select value={draft.defaultTo} disabled={busy} onChange={(e) => set('defaultTo', e.target.value)}>
              <option value="zh-CN">简体中文 zh-CN</option>
              <option value="zh-TW">繁體中文 zh-TW</option>
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <label className="note" style={{ display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={draft.backupBeforeRepack}
              disabled={busy}
              onChange={(e) => set('backupBeforeRepack', e.target.checked)}
            />
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
          <span className="mono" style={{ fontSize: 12 }}>
            {status.path}
          </span>
          <div className="spacer" />
          <button className="ghost" onClick={() => void api.reveal(status.path)}>
            打开所在目录
          </button>
        </div>
        <div className="note" style={{ marginTop: 8 }}>
          密钥与方案都存在这里（密钥经系统加密后存）。换机器/换用户后加密的密钥解不开，
          会当作"未配置" —— 那时重新填一次即可。
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
          <button className="primary" disabled={busy} onClick={() => void savePrefs()}>
            保存设置
          </button>
          <button className="ghost" disabled={busy} onClick={() => void load()}>
            放弃修改
          </button>
        </div>
      </div>
    </>
  );
}
