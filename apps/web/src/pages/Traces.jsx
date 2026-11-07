import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, ms, num, percentile, REASON_HELP } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { TraceList } from '../components/TraceList.jsx';
import { Waterfall } from '../components/Waterfall.jsx';
import { ReasonBadge } from '../components/Reasons.jsx';
import { EmptyState, ErrorNotice, PageHeader, Panel } from '../components/ui.jsx';

const VIEWS = [
  { key: '', label: 'Everything kept' },
  { key: 'errors', label: 'Errors', filters: { status: 'ERROR' } },
  { key: 'HIGH_LATENCY', label: 'Slow', filters: { reason: 'HIGH_LATENCY' } },
  { key: 'INCOMPLETE', label: 'Incomplete', filters: { reason: 'INCOMPLETE' } },
  { key: 'NORMAL_SAMPLED', label: 'Normal samples', filters: { reason: 'NORMAL_SAMPLED' } },
];

const WINDOWS = [
  { key: '', label: 'All time', ms: null },
  { key: '15m', label: 'Last 15m', ms: 900_000 },
  { key: '1h', label: 'Last hour', ms: 3_600_000 },
  { key: '24h', label: 'Last 24h', ms: 86_400_000 },
];

export function Traces({ pid, base, traceId }) {
  const { query, navigate } = useRouter();
  const view = query.get('status') === 'ERROR' ? 'errors' : query.get('reason') || '';
  const service = query.get('service') || '';
  const minMs = query.get('min_ms') || '';
  const archived = query.get('archived') === '1';
  const loadtest = query.get('loadtest') || '';
  const since = query.get('since') || '';
  const [pages, setPages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [lookup, setLookup] = useState('');

  const buildFilters = () => {
    const windowMs = WINDOWS.find((w) => w.key === since)?.ms;
    return {
      ...(VIEWS.find((v) => v.key === view)?.filters || {}),
      service: service || undefined,
      min_duration_ms: minMs || undefined,
      include_archived: archived ? 'true' : undefined,
      loadtest: loadtest || undefined,
      from: windowMs ? Date.now() - windowMs : undefined,
      limit: 30,
    };
  };

  const list = useData(() => api.traces(pid, buildFilters()), [pid, view, service, minMs, archived, loadtest, since], { every: 5000 });
  const services = useData(() => api.services(pid), [pid], { every: 30000 });
  useEffect(() => { setPages([]); setCursor(null); }, [pid, view, service, minMs, archived, loadtest, since]);
  useEffect(() => { if (list.data && !pages.length) setCursor(list.data.next_cursor); }, [list.data, pages.length]);

  const setParam = (k, v) => {
    const p = new URLSearchParams(query);
    if (v) p.set(k, v); else p.delete(k);
    if (k === 'view') {
      p.delete('status'); p.delete('reason');
      const f = VIEWS.find((x) => x.key === v)?.filters || {};
      for (const [a, b] of Object.entries(f)) p.set(a, b);
    }
    navigate(`${base}/traces${p.toString() ? '?' + p : ''}`, { replace: true });
  };

  const loadMore = async () => {
    const r = await api.traces(pid, { ...buildFilters(), cursor });
    setPages((p) => [...p, ...r.items]);
    setCursor(r.next_cursor);
  };

  const items = [...(list.data?.items || []), ...pages, ...(list.data?.archived || [])];
  const durations = items.map((t) => t.duration_ms).filter((v) => Number.isFinite(v));
  const errors = items.filter((t) => t.status === 'ERROR').length;
  const slowItems = items.filter((t) => t.sample_reason === 'HIGH_LATENCY').length;
  const open = (id) => navigate(`${base}/traces/${id}${query.toString() ? '?' + query : ''}`);

  return (
    <>
      <PageHeader
        title="Traces"
        description="One trace is one request travelling through your services. Search, filter, then open a trace to see where the time went."
        actions={(
          <form className="row trace-lookup" onSubmit={(e) => { e.preventDefault(); if (lookup.trim()) open(lookup.trim()); }}>
            <input aria-label="Trace id" placeholder="Find by trace id" value={lookup} onChange={(e) => setLookup(e.target.value)} className="mono" spellCheck="false" />
            <button type="submit" className="quiet" disabled={!lookup.trim()}>Open</button>
          </form>
        )}
      />

      <div className={`traces-layout${traceId ? '' : ' single'}`}>
        <Panel className="traces-list-panel" title="Stored traces" subtitle={`${num(items.length)} loaded${since ? ` · ${WINDOWS.find((w) => w.key === since)?.label.toLowerCase()}` : ''}`}>
          <div className="filters">
            <div className="chips" role="group" aria-label="Show">
              {VIEWS.map((v) => (
                <button key={v.key || 'all'} type="button" className="chip" aria-pressed={view === v.key} onClick={() => setParam('view', v.key)}>{v.label}</button>
              ))}
            </div>
            <div className="filter-row">
              <label className="filter-field">
                <span>Service</span>
                <select value={service} onChange={(e) => setParam('service', e.target.value)}>
                  <option value="">All services</option>
                  {(services.data?.services || []).map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="filter-field">
                <span>Duration</span>
                <select value={minMs} onChange={(e) => setParam('min_ms', e.target.value)}>
                  <option value="">Any duration</option>
                  <option value="100">Slower than 100 ms</option>
                  <option value="500">Slower than 500 ms</option>
                  <option value="1000">Slower than 1 s</option>
                  <option value="2000">Slower than 2 s</option>
                </select>
              </label>
              <label className="filter-field">
                <span>Window</span>
                <select value={since} onChange={(e) => setParam('since', e.target.value)}>
                  {WINDOWS.map((w) => <option key={w.key || 'all'} value={w.key}>{w.label}</option>)}
                </select>
              </label>
              <label className="filter-check">
                <input type="checkbox" checked={archived} onChange={(e) => setParam('archived', e.target.checked ? '1' : '')} /> Include archived
              </label>
            </div>
            {loadtest ? <button type="button" className="chip" aria-pressed="true" onClick={() => setParam('loadtest', '')} title="Show all traces again">Only test run {loadtest.slice(-6)} ✕</button> : null}
          </div>

          {items.length ? (
            <div className="result-strip" role="status">
              <span><b>{num(items.length)}</b> loaded</span>
              <span className={errors ? 'text-bad' : ''}><b>{num(errors)}</b> errors</span>
              <span className={slowItems ? 'text-warn' : ''}><b>{num(slowItems)}</b> slow</span>
              <span><b>{durations.length ? ms(percentile(durations, 50)) : '–'}</b> median duration</span>
            </div>
          ) : null}

          <ErrorNotice error={list.error} />
          {list.loading && !list.data ? <p className="muted">Loading traces…</p> : null}
          {list.data && !items.length ? (
            <EmptyState title="No traces match.">
              {view ? 'Try "Everything kept", widen the time window, or wait for more traffic.' : 'Send requests to your app. Traces appear a few seconds after each request finishes.'}
            </EmptyState>
          ) : (
            <TraceList items={items} selected={traceId} onSelect={open} />
          )}
          {cursor ? <div className="load-more"><button type="button" className="quiet" onClick={loadMore}>Show older traces</button></div> : null}
        </Panel>

        {traceId ? <TraceDetail pid={pid} traceId={traceId} onClose={() => navigate(`${base}/traces${query.toString() ? '?' + query : ''}`)} /> : null}
      </div>
    </>
  );
}

const SOURCE_TEXT = {
  hot: 'Stored in the searchable hot tier',
  in_flight: 'Still arriving: waiting for more spans before the sampling decision',
  pending: 'Kept, waiting to be written in the next batch',
  cold: 'Read from the long-term archive',
};

function TraceDetail({ pid, traceId, onClose }) {
  const res = useData(() => api.trace(pid, traceId), [pid, traceId], { every: 4000 });
  const t = res.data?.trace;
  return (
    <Panel className="trace-detail" aria-label="Trace detail" title={t ? (t.root_operation || 'Trace') : 'Trace'} subtitle={<span className="mono trace-id">{traceId}</span>} actions={<button type="button" className="quiet" onClick={onClose}>Close</button>}>
      {res.error ? (
        <div className="notice bad" role="alert">{res.error.status === 404 ? 'This trace was not kept. Healthy traces are sampled, so most of them are skipped on purpose.' : res.error.message}</div>
      ) : !t ? <p className="muted">Loading…</p> : (
        <>
          <div className="facts">
            <span><b>{ms(t.duration_ms)}</b> total</span>
            <span><b>{t.span_count}</b> {t.span_count === 1 ? 'span' : 'spans'}</span>
            <span><b>{(t.services || []).length}</b> {(t.services || []).length === 1 ? 'service' : 'services'}</span>
            <span>{t.status === 'ERROR' ? <b className="text-bad">Failed</b> : <b className="text-ok">Succeeded</b>}</span>
            <ReasonBadge reason={t.sample_reason} />
            {t.is_complete === false ? <span title="Some spans never arrived">Incomplete</span> : null}
          </div>
          <p className="small muted trace-source">
            {SOURCE_TEXT[res.data.source] || res.data.source}{t.finalized_at ? `, finished ${ago(t.finalized_at)}.` : '.'}
            {t.sample_reason ? ` ${REASON_HELP[t.sample_reason]}` : ''}
          </p>
          <Waterfall trace={t} />
        </>
      )}
    </Panel>
  );
}
