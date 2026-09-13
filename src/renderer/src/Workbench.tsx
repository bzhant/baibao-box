import React from 'react';

/**
 * 人工修订工作台（工作台能力）
 *
 * 满足的功能清单（对照文档原文）：
 *   · 树形浏览（按 path）      → 左侧"文件树"，来自 wbList 的 pathCounts
 *   · 搜索                     → 走 FTS（store.search）
 *   · 过滤"已译/未译/待复核"   → 状态筛选
 *   · 单条编辑                 → 右侧编辑区
 *   · 批量替换                 → **先预演给样例，确认后再写**
 *   · 导入导出                 → JSON 译文包（无损；PO 见下方说明）
 *   · 覆盖率                   → 顶部进度条
 *
 * ── 三个来自实际使用场景的设计决定 ──
 *
 * ① **批量替换必须先预演**。它是不可逆的批量写操作，只报"改了 300 条"用户没法
 *    判断改得对不对。所以先 dryRun，把**前后对比样例**摆出来，确认了再真写。
 *
 * ② **编辑是"改完即存"**，不做"整页暂存"。
 *    原因：修译文最常见的动作是"看一句、改一句、继续看下一句"。
 *    要求用户先点"保存整页"会丢改动；每条独立保存最贴合这个流程。
 *
 * ③ **改原文要明确警告**。原文变了，旧译文就不再对应，
 *    所以改原文会把该条打回"未译"并需要重新翻译 —— 这一点必须写在界面上，
 *    否则用户会发现"我改了原文，译文没了"，以为是 bug。
 */

interface Entry {
  engine: string;
  path: string;
  key: string;
  source: string;
  translated?: string;
  status: 'pending' | 'translated' | 'reviewed' | 'conflict';
}

interface Page {
  gameId: string;
  total: number;
  offset: number;
  limit: number;
  entries: Entry[];
  stats: { total: number; byStatus: Record<string, number> };
  pathCounts: Array<{ path: string; count: number }>;
}

type Res<T> = { ok: boolean; data?: T; error?: string };

const STATUS_LABEL: Record<string, string> = {
  pending: '未译',
  translated: '已译',
  reviewed: '已复核',
  conflict: '冲突',
};

const api = window.baibao;

export default function Workbench({ gameDir }: { gameDir: string }): React.ReactElement {
  const [page, setPage] = React.useState<Page | null>(null);
  const [status, setStatus] = React.useState<string>('');
  const [pathPrefix, setPathPrefix] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState('');
  const [info, setInfo] = React.useState('');

  const [editing, setEditing] = React.useState<Entry | null>(null);
  const [draft, setDraft] = React.useState('');

  // 回写到游戏
  const [rpPrev, setRpPrev] = React.useState<{
    supported: boolean; reason?: string; willWrite: number; engineName: string;
    counts: { translated: number; reviewed: number; pending: number; conflict: number };
    samples: Array<{ path: string; key: string; source: string; translated: string }>;
  } | null>(null);
  const [rpDone, setRpDone] = React.useState<{
    repack: { written: number; unchanged: number; skipped: number; backupDir: string; errors: string[] };
    engineName: string; durationMs: number;
  } | null>(null);

  // 批量替换
  const [bFind, setBFind] = React.useState('');
  const [bReplace, setBReplace] = React.useState('');
  const [bField, setBField] = React.useState<'translated' | 'source'>('translated');
  const [bPreview, setBPreview] = React.useState<{
    scanned: number; matched: number; changed: number; dryRun: boolean;
    samples: Array<{ path: string; key: string; before: string; after: string }>;
  } | null>(null);

  const load = React.useCallback(async (over?: Partial<{ status: string; pathPrefix: string; search: string }>) => {
    if (!gameDir) return;
    setBusy(true);
    setErr('');
    const st = over && 'status' in over ? over.status! : status;
    const pp = over && 'pathPrefix' in over ? over.pathPrefix! : pathPrefix;
    const sq = over && 'search' in over ? over.search! : search;
    const r = await api.wbList(gameDir, {
      status: st || undefined,
      pathPrefix: pp || undefined,
      search: sq || undefined,
      limit: 200,
    }) as Res<Page>;
    setBusy(false);
    if (!r.ok || !r.data) { setErr(r.error ?? '读取失败'); return; }
    setPage(r.data);
  }, [gameDir, status, pathPrefix, search]);

  React.useEffect(() => { void load(); /* 首次进入自动加载 */ }, [gameDir]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setErr('');
    const r = await api.wbSave(gameDir, editing.path, editing.key, draft, editing.status === 'reviewed' ? 'reviewed' : undefined);
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '保存失败'); return; }
    setInfo(`已保存：${editing.path} / ${editing.key}`);
    setEditing(null);
    await load();
  };

  const doBulk = async (dryRun: boolean): Promise<void> => {
    if (!bFind) { setErr('请填"查找内容"'); return; }
    setBusy(true);
    setErr('');
    const r = await api.wbBulk(gameDir, {
      field: bField, find: bFind, replace: bReplace,
      status: status || undefined, pathPrefix: pathPrefix || undefined, dryRun,
    }) as Res<typeof bPreview>;
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '批量替换失败'); return; }
    setBPreview(r.data ?? null);
    setInfo(dryRun
      ? `预演：命中 ${r.data?.matched ?? 0} 条。确认样例无误后点"确认替换"。`
      : `已替换 ${r.data?.changed ?? 0} 条。`);
    if (!dryRun) await load();
  };

  const previewRepack = async (): Promise<void> => {
    setBusy(true); setErr(''); setRpDone(null);
    const r = await api.wbRepackPreview(gameDir) as Res<typeof rpPrev>;
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '预览失败'); return; }
    setRpPrev(r.data ?? null);
  };

  const doRepack = async (): Promise<void> => {
    if (!rpPrev) return;
    // 回写是**改写游戏文件**的操作：必须二次确认（与批量替换同一套安全设计）
    const yes = window.confirm(
      `确定要回写吗？\n\n将把 ${rpPrev.willWrite} 条译文写进游戏文件。\n` +
      `回写前会自动备份，之后可以用「汉化」页的"一键还原"回到翻译前。`,
    );
    if (!yes) return;
    setBusy(true); setErr('');
    const r = await api.wbRepack(gameDir) as Res<typeof rpDone>;
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '回写失败'); return; }
    setRpDone(r.data ?? null);
    setInfo(`回写完成：写入 ${r.data?.repack.written ?? 0} 条`);
    await load();
  };

  const doExport = async (): Promise<void> => {
    setErr('');
    const p = await api.wbPickExport();
    if (!p.ok || !p.data) return;
    setBusy(true);
    const r = await api.wbExport(gameDir, p.data) as Res<{ file: string; count: number }>;
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '导出失败'); return; }
    setInfo(`已导出 ${r.data?.count ?? 0} 条到 ${r.data?.file ?? ''}`);
  };

  const doImport = async (): Promise<void> => {
    setErr('');
    const p = await api.wbPickImport();
    if (!p.ok || !p.data) return;
    setBusy(true);
    const r = await api.wbImport(gameDir, p.data) as Res<{ read: number; applied: number; skipped: number; missing: number }>;
    setBusy(false);
    if (!r.ok) { setErr(r.error ?? '导入失败'); return; }
    const d = r.data!;
    setInfo(`导入：读 ${d.read} 条，应用 ${d.applied} 条，跳过 ${d.skipped} 条，**库里没有 ${d.missing} 条**`);
    await load();
  };

  const s = page?.stats;
  const done = s ? (s.byStatus['translated'] ?? 0) + (s.byStatus['reviewed'] ?? 0) : 0;
  const rate = s && s.total > 0 ? done / s.total : 0;

  if (!gameDir) {
    return (
      <div className="card">
        <div className="note">先在「汉化」页选一个游戏目录，这里才能浏览它的文本。</div>
      </div>
    );
  }

  return (
    <>
      {/* ── 覆盖率 + 工具栏 ── */}
      <div className="card">
        <h3>覆盖率</h3>
        <div className="row">
          <span className="chip">共 {s?.total ?? 0} 条</span>
          <span className="chip ok">已译/已复核 {done}</span>
          <span className="chip warn">未译 {s?.byStatus['pending'] ?? 0}</span>
          {(s?.byStatus['conflict'] ?? 0) > 0 && <span className="chip err">冲突 {s?.byStatus['conflict']}</span>}
          <div className="spacer" />
          <button className="ghost" onClick={doExport} disabled={busy}>导出译文包</button>
          <button className="ghost" onClick={doImport} disabled={busy}>导入译文包</button>
        </div>
        <div className="bar"><i style={{ width: `${Math.round(rate * 100)}%` }} /></div>
        <div className="note">{(rate * 100).toFixed(1)}% 已完成</div>
      </div>

      {/* ── 回写到游戏（闭环缺口：改完的译文要能落进游戏）── */}
      <div className="card">
        <h3>回写到游戏</h3>
        <div className="note" style={{ marginBottom: 12 }}>
          把库里 <b>已译 / 已复核</b> 的译文写回游戏文件。
          <span className="muted">（未译与<b>冲突</b>的条目不会被写入 —— 冲突条目的控制符占位有问题，
          写进去会破坏游戏文本，宁可漏写也不能写错。）</span>
        </div>
        <div className="row">
          <button onClick={() => void previewRepack()} disabled={busy}>预览将要回写的内容</button>
          <button className="danger" disabled={busy || !rpPrev || !rpPrev.supported || rpPrev.willWrite === 0}
            onClick={() => void doRepack()}>确认回写</button>
        </div>

        {rpPrev && (
          <>
            {!rpPrev.supported && (
              <div className="warnbox">{rpPrev.reason ?? '这个引擎不支持静态回写。'}</div>
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <span className="chip ok">将写入 {rpPrev.willWrite} 条</span>
              <span className="chip">已译 {rpPrev.counts.translated}</span>
              <span className="chip">已复核 {rpPrev.counts.reviewed}</span>
              <span className="chip warn">未译 {rpPrev.counts.pending}（不写）</span>
              {rpPrev.counts.conflict > 0 && <span className="chip err">冲突 {rpPrev.counts.conflict}（不写）</span>}
            </div>
            {rpPrev.samples.length > 0 && (
              <table>
                <tbody>
                  {rpPrev.samples.map((x, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontWeight: 400, fontSize: 11 }}>
                        <div className="muted">{x.path.replace(/^.*[/\\]/, '')} / {x.key}</div>
                        <div className="muted" style={{ color: '#7d8797' }}>{x.source}</div>
                        <div style={{ color: '#93d2ab' }}>{x.translated}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}

        {rpDone && (
          <>
            <div className="okbox">
              回写完成：写入 {rpDone.repack.written} 条 · 无需改动 {rpDone.repack.unchanged} 条 ·
              跳过 {rpDone.repack.skipped} 条 · 耗时 {rpDone.durationMs}ms
            </div>
            {rpDone.repack.backupDir && (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="note">回写前已自动备份：</span>
                <button className="ghost" style={{ padding: '3px 9px', fontSize: 11 }}
                  onClick={() => void api.reveal(rpDone.repack.backupDir)}>打开备份目录</button>
              </div>
            )}
            {rpDone.repack.errors.length > 0 && (
              <div className="errbox">{rpDone.repack.errors.map((e, i) => <div key={i}>✗ {e}</div>)}</div>
            )}
          </>
        )}
      </div>

      {/* ── 筛选 ── */}
      <div className="card">
        <h3>筛选</h3>
        <div className="row">
          <div className="field">
            <label>状态</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); void load({ status: e.target.value }); }}>
              <option value="">全部</option>
              <option value="pending">未译</option>
              <option value="translated">已译</option>
              <option value="reviewed">已复核</option>
              <option value="conflict">冲突</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label>搜索原文 / 译文</label>
            <input
              type="text" value={search} placeholder="输入关键词后回车"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void load({ search }); }}
            />
          </div>
          <button onClick={() => void load({ search })} disabled={busy}>搜索</button>
          {pathPrefix && (
            <>
              <span className="chip">仅看 {pathPrefix}</span>
              <button className="ghost" onClick={() => { setPathPrefix(''); void load({ pathPrefix: '' }); }}>清除</button>
            </>
          )}
        </div>

        {page && page.pathCounts.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div className="note" style={{ marginBottom: 7 }}>文件（点一个只看它）</div>
            <div className="row">
              {page.pathCounts.slice(0, 14).map((p) => (
                <button
                  key={p.path} className="ghost" style={{ fontSize: 11.5, padding: '4px 10px' }}
                  onClick={() => { setPathPrefix(p.path); void load({ pathPrefix: p.path }); }}
                >{p.path.replace(/^.*[/\\]/, '')} <span className="muted">({p.count})</span></button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── 批量替换 ── */}
      <div className="card">
        <h3>批量替换</h3>
        <div className="row">
          <div className="field">
            <label>在哪个字段里找</label>
            <select value={bField} onChange={(e) => setBField(e.target.value as 'translated' | 'source')}>
              <option value="translated">译文</option>
              <option value="source">原文</option>
            </select>
          </div>
          <div className="field"><label>查找</label>
            <input type="text" value={bFind} onChange={(e) => setBFind(e.target.value)} /></div>
          <div className="field"><label>替换为</label>
            <input type="text" value={bReplace} onChange={(e) => setBReplace(e.target.value)} /></div>
          <button onClick={() => void doBulk(true)} disabled={busy || !bFind}>预演</button>
          <button
            className="danger" disabled={busy || !bFind || !bPreview || bPreview.dryRun === false}
            onClick={() => void doBulk(false)}
          >确认替换</button>
        </div>
        {bField === 'source' && (
          <div className="warnbox">
            改**原文**会把命中条目的译文清空、状态打回"未译"，需要重新翻译。
            原文的真正落盘发生在下一次"开始汉化"的抽取/回写阶段。
          </div>
        )}
        {bPreview && (
          <>
            <div className="note" style={{ marginTop: 10 }}>
              扫过 {bPreview.scanned} 条，命中 <b>{bPreview.matched}</b> 条
              {bPreview.dryRun ? '（预演，未写入）' : `，已写入 ${bPreview.changed} 条`}
            </div>
            {bPreview.samples.length > 0 && (
              <table>
                <tbody>
                  {bPreview.samples.slice(0, 6).map((x, i) => (
                    <tr key={i}>
                      <td className="mono" style={{ fontWeight: 400, fontSize: 11 }}>
                        <div className="muted">{x.path.replace(/^.*[/\\]/, '')} / {x.key}</div>
                        <div style={{ color: '#e4878d' }}>- {x.before}</div>
                        <div style={{ color: '#63c98a' }}>+ {x.after}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      {/* ── 条目列表 / 单条编辑 ── */}
      <div className="card">
        <h3>条目 <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>
          {page ? `显示 ${page.entries.length} / 命中 ${page.total}` : ''}
        </span></h3>

        {err && <div className="errbox">{err}</div>}
        {info && <div className="okbox">{info}</div>}

        {editing ? (
          <div style={{ marginTop: 12 }}>
            <div className="note" style={{ marginBottom: 8 }}>
              {editing.path} / <b>{editing.key}</b>
            </div>
            <div className="field" style={{ marginBottom: 10 }}>
              <label>原文</label>
              <div className="mono" style={{ background: '#0f1319', border: '1px solid #2a323e',
                borderRadius: 9, padding: '9px 11px', color: '#a8b4c4' }}>{editing.source}</div>
            </div>
            <div className="field">
              <label>译文（改完点保存，或点清空回未译）</label>
              <textarea
                value={draft} onChange={(e) => setDraft(e.target.value)} rows={4}
                style={{ background: '#0f1319', border: '1px solid #2a323e', color: '#e7ebf0',
                  borderRadius: 9, padding: '9px 11px', fontSize: 13, fontFamily: 'inherit',
                  outline: 'none', resize: 'vertical' }}
              />
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={save} disabled={busy}>保存</button>
              <button onClick={() => void (async () => {
                setDraft('');
                await api.wbSave(gameDir, editing.path, editing.key, null);
                setInfo('已清空该条译文（状态回到未译）');
                setEditing(null);
                await load();
              })()} disabled={busy}>清空</button>
              <button className="ghost" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        ) : (
          <table>
            <tbody>
              {(page?.entries ?? []).map((e) => (
                <tr
                  key={`${e.path}#${e.key}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { setEditing(e); setDraft(e.translated ?? ''); setInfo(''); }}
                >
                  <td style={{ fontWeight: 400 }}>
                    <div className="muted mono" style={{ fontSize: 10.5 }}>
                      {e.path.replace(/^.*[/\\]/, '')} / {e.key}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 2 }}>{e.source}</div>
                    <div style={{ fontSize: 12.5, marginTop: 2,
                      color: e.translated ? '#93d2ab' : '#5f6b7c' }}>
                      {e.translated || '（未译）'}
                    </div>
                  </td>
                  <td style={{ width: 70 }}>
                    <span className={`chip${e.status === 'conflict' ? ' err' : e.status === 'pending' ? ' warn' : ' ok'}`}>
                      {STATUS_LABEL[e.status] ?? e.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {!editing && page && page.entries.length === 0 && (
          <div className="note" style={{ marginTop: 10 }}>
            没有符合条件的条目。如果这个游戏还没跑过汉化，先回「汉化」页跑一次（可以勾掉"回写游戏文件"只抽取入库）。
          </div>
        )}
      </div>
    </>
  );
}
