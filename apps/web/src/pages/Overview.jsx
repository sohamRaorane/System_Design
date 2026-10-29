import { useMemo } from 'react';
import { api } from '../lib/api.js';
import { useData, usePrevious } from '../lib/hooks.js';
import { headline, pipelineStages } from '../lib/health.js';
import { FlowStrip } from '../components/FlowStrip.jsx';
import { Reasons } from '../components/Reasons.jsx';
import { TraceList } from '../components/TraceList.jsx';
import { useRouter } from '../lib/router.jsx';

export function Overview({ project, base, extra }) {
  const { navigate } = useRouter();
  const metrics = useData(() => api.metrics(), [], { every: 2000 });
  const prev = usePrevious(metrics.data);
  const stages = useMemo(() => pipelineStages(metrics.data, prev), [metrics.data, prev]);
  const head = headline(stages, metrics.data);
  const problems = useData(() => api.traces(project, { status: 'ERROR', limit: 6 }), [project], { every: 5000 });
  const slow = useData(() => api.traces(project, { reason: 'HIGH_LATENCY', limit: 4 }), [project], { every: 5000 });
  const attention = [...(problems.data?.items || []), ...(slow.data?.items || [])]
    .sort((a, b) => b.finalized_at - a.finalized_at).slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Pipeline overview</h1>
          <p>Every span your services send moves left to right through these stages. Each stop says what it is doing right now.</p>
        </div>
        {extra}
      </div>

      {metrics.error && !metrics.data ? (
        <div className="notice bad" role="alert">{metrics.error.message}</div>
      ) : (
        <>
          <div className="status-line" role="status" aria-live="polite">
            <span className={`dot ${head.state === 'ok' ? '' : head.state}`} />
            <div>{head.text}<small>{head.detail}</small></div>
          </div>
          <FlowStrip stages={stages} />
        </>
      )}

      <div className="grid-2">
        <section className="panel">
          <h2>What we kept and why</h2>
          <p className="sub">Tail-based sampling decides after a request finishes, so failures and slow requests are never lost.</p>
          <Reasons counts={metrics.data?.sampling.kept_by_reason} onPick={(r) => navigate(`${base}/traces?reason=${r}`)} />
        </section>
        <section className="panel">
          <h2>Traces that need attention</h2>
          <p className="sub">The latest failed and slow requests.</p>
          {attention.length ? (
            <TraceList items={attention} onSelect={(id) => navigate(`${base}/traces/${id}`)} />
          ) : (
            <div className="empty"><p>No failed or slow requests stored.</p><p className="small muted">They will appear here as soon as one happens.</p></div>
          )}
        </section>
      </div>
    </>
  );
}
