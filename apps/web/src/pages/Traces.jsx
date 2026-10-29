import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, ms, REASON_HELP } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { TraceList } from '../components/TraceList.jsx';
import { Waterfall } from '../components/Waterfall.jsx';
import { ReasonBadge } from '../components/Reasons.jsx';

const VIEWS = [
  { key: '', label: 'Everything kept' },
  { key: 'errors', label: 'Errors', filters: { status: 'ERROR' } },
  { key: 'HIGH_LATENCY', label: 'Slow', filters: { reason: 'HIGH_LATENCY' } },
  { key: 'INCOMPLETE', label: 'Incomplete', filters: { reason: 'INCOMPLETE' } },
  { key: 'NORMAL_SAMPLED', label: 'Normal samples', filters: { reason: 'NORMAL_SAMPLED' } },
];

export function Traces({ pid, base, traceId }) {
  const { query, navigate } = useRouter();
  const view = query.get('status') === 'ERROR' ? 'errors' : query.get('reason') || '';
  const service = query.get('service') || '';
  const minMs = query.get('min_ms') || '';
  const archived = query.get('archived') === '1';
  const [pages, setPages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [lookup, setLookup] = useState('');

  const filters = { ...(VIEWS.find((v) => v.key === view)?.filters || {}), service: service || undefined, min_duration_ms: minMs || undefined, include_archived: archived ? 'true' : undefined, limit: 30 };
  const list = useData(() => api.traces(pid, filters), [pid, view, service, minMs, archived], { every: 5000 });
  const services = useData(() => api.services(pid), [pid], { every: 30000 });
  useEffect(() => { setPages([]); setCursor(null); }, [pid, view, service, minMs, archived]);
  useEffect(() => { if (list.data && !pages.length) setCursor(list.data.next_cursor); }, [list.data, pages.length]);

  const setParam = (k, v) => {
    const p = new URLSearchParams(query);
    if (v) p.set(k, v); else p.delete(k);
    if (k === 'view') { p.delete('status'); p.delete('reason'); const f = VIEWS.find((x) => x.key === v)?.filters || {}; for (const [a, b] of Object.entries(f)) p.set(a, b); }
    navigate(`${base}/traces${p.toString() ? '?' + p : ''}`, { replace: true });
  };

  const loadMore = async () => {
    const r = await api.traces(pid, { ...filters, cursor });
    setPages((p) => [...p, ...r.items]);
    setCursor(r.next_cursor);
  };

  const items = [...(list.data?.items || []), ...pages, ...(list.data?.archived || [])];
  const open = (id) => navigate(`${base}/traces/${id}${query.toString() ? '?' + query : ''}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Traces</h1>
          <p>One trace is one request travelling through your services. Pick one to see where the time went.</p>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) open(lookup.trim()); }}>
          <input aria-label="Trace id" placeholder="Find by trace id" value={lookup} onChange={(e) => setLookup(e.target.value)} className="mono" style={{ width: 260 }} />
          <button type="submit" className="quiet">Open</button>
        </form>
      </div>

      <div className={'traces-layout' + (traceId ? '' : ' single')}>
        <section className="panel">
          <div className="filters">
            <div className="chips" role="group" aria-label="Show">
              {VIEWS.map((v) => (
                <button key={v.key || 'all'} type="button" className="chip" aria-pressed={view === v.key} onClick={() => setParam('view', v.key)}>{v.label}</button>
              ))}
            </div>
            <div className="row">
              <select aria-label="Service" value={service} onChange={(e) => setParam('service', e.target.value)}>
                <option value="">All services</option>
                {(services.data?.services || []).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select aria-label="Minimum duration" value={minMs} onChange={(e) => setParam('min_ms', e.target.value)}>
                <option value="">Any duration</option>
                <option value="100">Slower than 100 ms</option>
                <option value="500">Slower than 500 ms</option>
                <option value="1000">Slower than 1 s</option>
                <option value="2000">Slower than 2 s</option>
              </select>
              <label className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={archived} onChange={(e) => setParam('archived', e.target.checked ? '1' : '')} /> Include archived
              </label>
            </div>
          </div>
          {list.error ? <div className="notice bad" role="alert">{list.error.message}</div> : null}
          {list.loading && !list.data ? <p className="muted">Loading traces…</p> : null}
          {list.data && !items.length ? (
            <div className="empty">
              <p>No traces match.</p>
              <p className="small muted">{view ? 'Try "Everything kept", or wait for more traffic.' : 'Send requests to your app. Traces appear a few seconds after each request finishes.'}</p>
            </div>
          ) : (
            <TraceList items={items} selected={traceId} onSelect={open} />
          )}
          {cursor ? <div style={{ marginTop: 12 }}><button type="button" className="quiet" onClick={loadMore}>Show older traces</button></div> : null}
        </section>

        {traceId ? <TraceDetail pid={pid} traceId={traceId} onClose={() => navigate(`${base}/traces${query.toString() ? '?' + query : ''}`)} /> : null}
      </div>
    </>
  );
}

const SOURCE_TEXT = {
  hot: 'Stored',
  in_flight: 'Still arriving: waiting for more spans before the sampling decision',
  pending: 'Kept, waiting to be written in the next batch',
  cold: 'From the long-term archive',
};

function TraceDetail({ pid, traceId, onClose }) {
  const res = useData(() => api.trace(pid, traceId), [pid, traceId], { every: 4000 });
  const t = res.data?.trace;
  return (
    <section className="panel" aria-label="Trace detail">
      <div className="wf-head">
        <div>
          <h2>{t ? (t.root_operation || 'Trace') : 'Trace'}</h2>
          <div className="id">{traceId}</div>
        </div>
        <button type="button" className="quiet" onClick={onClose}>Close</button>
      </div>
      {res.error ? (
        <div className="notice bad" role="alert">{res.error.status === 404 ? 'This trace was not kept. Healthy traces are sampled, so most of them are skipped on purpose.' : res.error.message}</div>
      ) : !t ? <p className="muted">Loading…</p> : (
        <>
          <div className="facts">
            <span><b>{ms(t.duration_ms)}</b> total</span>
            <span><b>{t.span_count}</b> spans</span>
            <span><b>{(t.services || []).length}</b> services</span>
            <span>{t.status === 'ERROR' ? <b style={{ color: 'var(--bad)' }}>Failed</b> : <b>Succeeded</b>}</span>
            <ReasonBadge reason={t.sample_reason} />
            {t.is_complete === false ? <span title="Some spans never arrived">Incomplete</span> : null}
          </div>
          <p className="small muted" style={{ marginBottom: 12 }}>
            {SOURCE_TEXT[res.data.source] || res.data.source}{t.finalized_at ? `, finished ${ago(t.finalized_at)}.` : '.'}
            {t.sample_reason ? ` ${REASON_HELP[t.sample_reason]}` : ''}
          </p>
          <Waterfall trace={t} />
        </>
      )}
    </section>
  );
}
