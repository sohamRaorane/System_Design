import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { ago, ms, num, percentile } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { Sparkline } from '../components/charts.jsx';
import { EmptyState, ErrorNotice, LoadingSkeleton, MetricCard, PageHeader, Panel, StatusBadge } from '../components/ui.jsx';

const SAMPLE_LIMIT = 60;
const MAX_SERVICES = 12;

function summarise(items = []) {
  const durations = items.map((t) => t.duration_ms).filter(Number.isFinite);
  const errors = items.filter((t) => t.status === 'ERROR').length;
  const slow = items.filter((t) => t.sample_reason === 'HIGH_LATENCY').length;
  const last = items.length ? Math.max(...items.map((t) => t.finalized_at || 0)) : null;
  return {
    total: items.length,
    errors,
    slow,
    p95: percentile(durations, 95),
    median: percentile(durations, 50),
    last,
    durations,
  };
}

function toneFor(s) {
  if (!s.total) return 'idle';
  if (s.errors / s.total >= 0.2) return 'bad';
  if (s.errors > 0 || s.slow > 0) return 'warn';
  return 'ok';
}

export function Services({ pid, base }) {
  const { navigate } = useRouter();
  const services = useData(() => api.services(pid), [pid], { every: 30000 });
  const names = services.data?.services || [];
  const joined = names.join('|');
  const stats = useData(async () => {
    const capped = names.slice(0, MAX_SERVICES);
    const results = await Promise.all(capped.map((name) => api.traces(pid, { service: name, limit: SAMPLE_LIMIT })));
    return capped.map((name, i) => ({ name, ...summarise(results[i].items) }));
  }, [pid, joined], { every: 20000 });
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (stats.data || []).filter((s) => !q || s.name.toLowerCase().includes(q));
  }, [stats.data, filter]);

  const totals = useMemo(() => (stats.data || []).reduce((acc, s) => ({
    traces: acc.traces + s.total,
    errors: acc.errors + s.errors,
    slow: acc.slow + s.slow,
    active: acc.active + (s.last && Date.now() - s.last < 300_000 ? 1 : 0),
  }), { traces: 0, errors: 0, slow: 0, active: 0 }), [stats.data]);

  return (
    <>
      <PageHeader
        title="Services"
        description="Recent health per service, computed from the latest kept traces. Healthy traffic is sampled, so these are kept traces, not total request counts."
        actions={(
          <label className="filter-field inline">
            <span>Filter</span>
            <input placeholder="Filter services" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
        )}
      />

      <ErrorNotice error={services.error || stats.error} />

      <div className="metric-grid metric-grid-4">
        <MetricCard label="Services seen" value={num(names.length)} unit="in hot storage" hint={names.length > MAX_SERVICES ? `Showing the first ${MAX_SERVICES}` : 'Distinct service names'} tone="info" />
        <MetricCard label="Active now" value={num(totals.active)} unit="services" hint="A kept trace in the last 5 minutes" tone={totals.active ? 'ok' : 'idle'} />
        <MetricCard label="Errors in sample" value={num(totals.errors)} unit="traces" hint={`Across ${num(totals.traces)} sampled kept traces`} tone={totals.errors ? 'bad' : 'ok'} />
        <MetricCard label="Slow in sample" value={num(totals.slow)} unit="traces" hint="Above the project latency threshold" tone={totals.slow ? 'warn' : 'ok'} />
      </div>

      {services.loading && !services.data ? <LoadingSkeleton rows={4} label="Loading services" /> : null}
      {services.data && !names.length ? (
        <Panel title="No services yet">
          <EmptyState title="This project has not stored any spans yet.">
            Send traffic from an instrumented app, or start simulated traffic from the Load test page.
          </EmptyState>
        </Panel>
      ) : null}

      {names.length && !rows.length ? (
        <Panel title="No match">
          <EmptyState title={`No service matches “${filter}”.`}>Clear the filter to see every service.</EmptyState>
        </Panel>
      ) : null}

      {rows.length ? (
        <div className="service-grid">
          {rows.map((s) => {
            const tone = toneFor(s);
            const errorPct = s.total ? Math.round((s.errors / s.total) * 100) : 0;
            return (
              <article key={s.name} className={`service-card tone-${tone}`}>
                <div className="service-card-head">
                  <div>
                    <h3>{s.name}</h3>
                    <p className="service-card-sub">{s.total ? `${num(s.total)} recent kept traces` : 'No recent kept traces'}</p>
                  </div>
                  <StatusBadge tone={tone}>{tone === 'ok' ? 'Healthy' : tone === 'warn' ? 'Degraded' : tone === 'bad' ? 'Failing' : 'Idle'}</StatusBadge>
                </div>

                <div className="service-metrics">
                  <div><span>Errors</span><b className={s.errors ? 'text-bad' : ''}>{num(s.errors)}</b></div>
                  <div><span>Slow</span><b className={s.slow ? 'text-warn' : ''}>{num(s.slow)}</b></div>
                  <div><span>p95</span><b>{s.p95 === null ? '–' : ms(s.p95)}</b></div>
                  <div><span>Median</span><b>{s.median === null ? '–' : ms(s.median)}</b></div>
                </div>

                <div className="service-card-foot">
                  <span className="small muted">{s.last ? `Last trace ${ago(s.last)}` : 'No timestamp'}</span>
                  <button type="button" className="link-button" onClick={() => navigate(`${base}/traces?service=${encodeURIComponent(s.name)}`)}>Open traces</button>
                </div>

                <div className="service-spark">
                  <Sparkline points={s.durations.map((d, i) => ({ t: i, v: d }))} color={tone === 'bad' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--green)'} />
                  <span className="small muted">{errorPct}% errors · latest {SAMPLE_LIMIT}</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : null}

      {names.length > MAX_SERVICES ? (
        <p className="small muted">Showing {MAX_SERVICES} of {names.length} services. Use the trace filters to inspect the others by name.</p>
      ) : null}
    </>
  );
}
