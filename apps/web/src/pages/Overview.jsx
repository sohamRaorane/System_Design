import { useMemo } from 'react';
import { api } from '../lib/api.js';
import { useData, usePrevious } from '../lib/hooks.js';
import { headline, pipelineStages } from '../lib/health.js';
import { FlowStrip } from '../components/FlowStrip.jsx';
import { Reasons } from '../components/Reasons.jsx';
import { TraceList } from '../components/TraceList.jsx';
import { useRouter } from '../lib/router.jsx';
import { ago } from '../lib/format.js';

export function Overview({ pid, project, base, extra }) {
  const { navigate } = useRouter();
  const metrics = useData(() => api.pipeline(), [], { every: 2000 });
  const stats = useData(() => api.stats(pid), [pid], { every: 5000 });
  const prev = usePrevious(metrics.data);
  const stages = useMemo(() => pipelineStages(metrics.data, prev), [metrics.data, prev]);
  const head = headline(stages, metrics.data);
  const problems = useData(() => api.traces(pid, { status: 'ERROR', limit: 6 }), [pid], { every: 5000 });
  const slow = useData(() => api.traces(pid, { reason: 'HIGH_LATENCY', limit: 4 }), [pid], { every: 5000 });
  const live = stats.data?.live;
  const attention = [...(problems.data?.items || []), ...(slow.data?.items || [])]
    .sort((a, b) => b.finalized_at - a.finalized_at).slice(0, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project?.name || 'Overview'}</h1>
          <p>Every span your services send moves left to right through these stages. Each stop says what it is doing right now.</p>
        </div>
        {extra}
      </div>

      {project && !project.first_trace_at ? (
        <div className="notice warn" style={{ marginBottom: 20 }}>
          <b>No traces from this project yet.</b> {project.repo ? 'Merge the pull request we opened and deploy your app, then send it a few requests.' : 'Connect a repository, or add the environment variables from Settings to your app.'}
          <span className="row" style={{ marginTop: 10 }}>
            {!project.repo && !project.is_default ? <button type="button" onClick={() => navigate(`${base}/connect`)}>Connect a repository</button> : null}
            <button type="button" className="quiet" onClick={() => navigate(`${base}/settings`)}>Set up by hand</button>
          </span>
        </div>
      ) : null}
      {metrics.error && !metrics.data ? (
        <div className="notice bad" role="alert">{metrics.error.message}</div>
      ) : (
        <>
          <div className="status-line" role="status" aria-live="polite">
            <span className={`dot ${head.state === 'ok' ? '' : head.state}`} />
            <div>{head.text}<small>{head.detail}</small></div>
          </div>
          <FlowStrip stages={stages} />
          {live ? <p className="small muted" style={{ margin: '-14px 0 22px' }}>The strip shows the whole collector. This project: {live.spans_per_sec} spans a second{live.last_span_at ? `, last span ${ago(live.last_span_at)}` : ''}.</p> : null}
        </>
      )}

      <div className="grid-2">
        <section className="panel">
          <h2>What we kept and why</h2>
          <p className="sub">Last 24 hours. Tail-based sampling decides after a request finishes, so failures and slow requests are never lost.</p>
          <Reasons counts={stats.data?.kept_24h} onPick={(r) => navigate(r === 'ERROR' ? `${base}/traces?status=ERROR` : `${base}/traces?reason=${r}`)} />
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
