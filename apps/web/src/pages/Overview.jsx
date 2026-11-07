import { useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useData } from '../lib/hooks.js';
import { headline, pipelineChecks, pipelineStages } from '../lib/health.js';
import { RANGES, withinRange, usePipeline } from '../lib/pipeline.js';
import { ago, ms, num, plural } from '../lib/format.js';
import { useRouter } from '../lib/router.jsx';
import { ActivityTimeline } from '../components/ActivityTimeline.jsx';
import { DonutChart, Histogram, LineChart, Sparkline } from '../components/charts.jsx';
import { TraceList } from '../components/TraceList.jsx';
import {
  EmptyState, ErrorNotice, LoadingSkeleton, MetricCard, PageHeader, Panel, StatusBadge, TimeRange,
} from '../components/ui.jsx';

const REASON_COLOURS = {
  ERROR: 'var(--red)',
  HIGH_LATENCY: 'var(--amber)',
  INCOMPLETE: 'var(--purple)',
  NORMAL_SAMPLED: 'var(--green)',
};
const REASON_LABEL = {
  ERROR: 'Errors',
  HIGH_LATENCY: 'Slow',
  INCOMPLETE: 'Incomplete',
  NORMAL_SAMPLED: 'Normal samples',
};
const STATE_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'idle' };

export function Overview({ pid, project, base }) {
  const { navigate } = useRouter();
  const pipeline = usePipeline();
  const stats = useData(() => api.stats(pid), [pid], { every: 5000 });
  const problems = useData(() => api.traces(pid, { status: 'ERROR', limit: 6 }), [pid], { every: 5000 });
  const slow = useData(() => api.traces(pid, { reason: 'HIGH_LATENCY', limit: 4 }), [pid], { every: 5000 });
  const recent = useData(() => api.traces(pid, { limit: 12 }), [pid], { every: 5000 });
  const [rangeKey, setRangeKey] = useState('5m');

  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[1];
  const history = useMemo(() => withinRange(pipeline.history, range.ms), [pipeline.history, range.ms]);
  const stages = useMemo(() => pipelineStages(pipeline.data, pipeline.prev), [pipeline.data, pipeline.prev]);
  const head = headline(stages, pipeline.data);
  const checks = useMemo(() => pipelineChecks(pipeline.data), [pipeline.data]);

  const live = stats.data?.live;
  const kept = stats.data?.kept_24h || {};
  const keptTotal = Object.values(kept).reduce((a, b) => a + (b || 0), 0);
  const errors = kept.ERROR || 0;
  const slowCount = kept.HIGH_LATENCY || 0;
  const threshold = stats.data?.effective?.latency_threshold_ms;
  const storeP95 = pipeline.data?.storage?.finalize_to_stored_ms?.p95;
  const storeP50 = pipeline.data?.storage?.finalize_to_stored_ms?.p50;

  const attention = useMemo(() => (
    [...(problems.data?.items || []), ...(slow.data?.items || [])]
      .sort((a, b) => b.finalized_at - a.finalized_at)
      .slice(0, 8)
  ), [problems.data, slow.data]);

  const durations = useMemo(
    () => (recent.data?.items || []).map((t) => t.duration_ms).filter((v) => Number.isFinite(v)),
    [recent.data],
  );

  const reasons = ['ERROR', 'HIGH_LATENCY', 'INCOMPLETE', 'NORMAL_SAMPLED'].map((key) => ({
    key,
    label: REASON_LABEL[key],
    value: kept[key] || 0,
    color: REASON_COLOURS[key],
  }));

  const throughputSeries = [{
    key: 'ingest', label: 'Ingest rate', color: 'var(--accent)',
    points: history.map((h) => ({ t: h.t, v: h.ingestRate })),
  }];
  const queueSeries = [
    { key: 'queue', label: 'Queue depth', color: 'var(--accent)', points: history.map((h) => ({ t: h.t, v: h.queueDepth })) },
    { key: 'open', label: 'Open traces', color: 'var(--purple)', points: history.map((h) => ({ t: h.t, v: h.openTraces })) },
  ];
  const latencySeries = [
    { key: 'p50', label: 'p50', color: 'var(--green)', points: history.map((h) => ({ t: h.t, v: h.storageP50 })) },
    { key: 'p95', label: 'p95', color: 'var(--amber)', points: history.map((h) => ({ t: h.t, v: h.storageP95 })) },
  ];

  return (
    <>
      <PageHeader
        eyebrow={project?.name || 'Project'}
        title="Overview"
        description="Live health of the trace pipeline for this project. Charts plot collector samples gathered by this dashboard; they are not synthetic."
        actions={(
          <>
            <TimeRange value={rangeKey} onChange={setRangeKey} ranges={RANGES} label="Chart time range" />
            <StatusBadge tone={STATE_TONE[head.state] || 'neutral'} pulse={head.state === 'ok'}>
              {head.state === 'ok' ? 'Healthy' : head.state === 'warn' ? 'Warning' : head.state === 'bad' ? 'Critical' : 'Idle'}
            </StatusBadge>
          </>
        )}
      />

      {project && !project.first_trace_at ? (
        <div className="notice warn onboarding" role="status">
          <b>No traces from this project yet.</b>{' '}
          {project.repo ? 'Merge the pull request we opened and deploy your app, then send it a few requests.' : 'Connect a repository, or add the environment variables from Settings to your app.'}
          <div className="row" style={{ marginTop: 10 }}>
            {!project.repo && !project.is_default ? <button type="button" onClick={() => navigate(`${base}/connect`)}>Connect a repository</button> : null}
            <button type="button" className="quiet" onClick={() => navigate(`${base}/settings`)}>Set up by hand</button>
            <button type="button" className="quiet" onClick={() => navigate(`${base}/load`)}>Try simulated traffic</button>
          </div>
        </div>
      ) : null}

      <section className={`status-banner tone-${head.state}`} role="status" aria-live="polite">
        <span className={`status-orb tone-${head.state}`} aria-hidden="true" />
        <div className="status-banner-text">
          <b>{head.text}</b>
          <span>{head.detail}</span>
        </div>
        <div className="status-banner-meta">
          {live ? <span>{num(live.spans_per_sec)} spans/s this project</span> : null}
          {live?.last_span_at ? <span>last span {ago(live.last_span_at)}</span> : <span>no spans yet</span>}
        </div>
      </section>

      {pipeline.error ? (
        <div className="notice warn" role="status" style={{ marginBottom: 16 }}>
          Live collector metrics are temporarily unavailable ({pipeline.error.message}). Showing the last successful sample and project data.
        </div>
      ) : null}
      <ErrorNotice error={stats.error} />

      <div className="metric-grid">
        <MetricCard
          label="Collector ingest rate"
          value={num(pipeline.data?.ingestion?.ingest_rate_per_sec ?? 0)}
          unit="spans/s"
          hint="Rolling 5-second average across every project"
          tone="info"
          spark={<Sparkline points={history.map((h) => ({ t: h.t, v: h.ingestRate }))} color="var(--accent)" />}
        />
        <MetricCard
          label="This project"
          value={num(live?.spans_per_sec ?? 0)}
          unit="spans/s"
          hint={live?.last_span_at ? `Last span ${ago(live.last_span_at)}` : 'Waiting for the first span'}
          tone={live?.spans_per_sec ? 'ok' : 'idle'}
          spark={<Sparkline points={history.map((h) => ({ t: h.t, v: h.ingestRate }))} color="var(--green)" />}
        />
        <MetricCard
          label="Kept traces · 24h"
          value={num(keptTotal)}
          unit="traces"
          hint={`${num(errors)} errors, ${num(slowCount)} slow requests`}
          tone={errors ? 'warn' : 'neutral'}
        />
        <MetricCard
          label="Failed traces · 24h"
          value={num(errors)}
          unit="kept"
          hint={keptTotal ? `${Math.round((errors / keptTotal) * 100)}% of kept traces` : 'No kept traces yet'}
          tone={errors ? 'bad' : 'ok'}
        />
        <MetricCard
          label="Hot storage"
          value={num(stats.data?.hot_traces ?? 0)}
          unit="traces"
          hint={`${num(stats.data?.archived_traces ?? 0)} archived in cold storage`}
          tone="neutral"
        />
        <MetricCard
          label="Finalize → stored"
          value={storeP95 === null || storeP95 === undefined ? '–' : ms(storeP95)}
          unit="p95"
          hint={storeP50 === null || storeP50 === undefined ? 'No write samples yet' : `p50 ${ms(storeP50)}${threshold ? ` · slow threshold ${ms(threshold)}` : ''}`}
          tone={storeP95 !== null && storeP95 !== undefined && threshold && storeP95 > threshold ? 'warn' : 'neutral'}
        />
      </div>

      <div className="dash-grid dash-grid-2-1">
        <Panel
          title="Ingest throughput"
          subtitle={`Collector spans per second · ${range.label} window · sampled every 2 s`}
          actions={<span className="panel-tag">{history.length} samples</span>}
        >
          {history.length ? (
            <LineChart series={throughputSeries} formatValue={(v) => num(v)} area ariaLabel="Collector ingest rate over time" />
          ) : <LoadingSkeleton rows={3} label="Waiting for collector samples" />}
        </Panel>

        <Panel
          title="Sampling decisions · 24h"
          subtitle="Tail-based sampling keeps every failure and slow request."
          actions={<button type="button" className="link-button" onClick={() => navigate(`${base}/traces`)}>View traces</button>}
        >
          <DonutChart
            data={reasons}
            centerLabel="kept"
            centerValue={num(keptTotal)}
            onSelect={(key) => navigate(key === 'ERROR' ? `${base}/traces?status=ERROR` : `${base}/traces?reason=${key}`)}
          />
        </Panel>
      </div>

      <div className="dash-grid dash-grid-2">
        <Panel
          title="Queue and in-flight traces"
          subtitle="Backpressure appears here before senders are refused."
          actions={<StatusBadge tone={pipeline.data?.queue?.queue_state === 'FULL' ? 'bad' : pipeline.data?.queue?.queue_state === 'SOFT' ? 'warn' : 'ok'}>{pipeline.data?.queue?.queue_state || 'unknown'}</StatusBadge>}
        >
          {history.length ? <LineChart series={queueSeries} formatValue={(v) => num(v)} ariaLabel="Queue depth and open traces over time" /> : <LoadingSkeleton rows={3} />}
        </Panel>
        <Panel
          title="Storage write latency"
          subtitle="Delay from a trace being finalized to a successful database write."
          actions={<span className="panel-tag">p50 / p95</span>}
        >
          {history.length ? <LineChart series={latencySeries} formatValue={(v) => ms(v)} ariaLabel="Store latency percentiles over time" /> : <LoadingSkeleton rows={3} />}
        </Panel>
      </div>

      <div className="dash-grid dash-grid-2">
        <Panel
          title="Traces that need attention"
          subtitle="The latest failed and slow requests kept by the sampler."
          actions={<button type="button" className="link-button" onClick={() => navigate(`${base}/traces?status=ERROR`)}>All errors</button>}
        >
          {attention.length ? (
            <TraceList items={attention} onSelect={(id) => navigate(`${base}/traces/${id}`)} />
          ) : (
            <EmptyState title="No failed or slow requests stored.">They will appear here as soon as one happens.</EmptyState>
          )}
        </Panel>
        <Panel title="Recent activity" subtitle="Latest kept traces, newest first.">
          {recent.loading && !recent.data ? <LoadingSkeleton rows={5} /> : (
            <ActivityTimeline items={recent.data?.items || []} onSelect={(id) => navigate(`${base}/traces/${id}`)} />
          )}
        </Panel>
      </div>

      <div className="dash-grid dash-grid-2-1">
        <Panel
          title="Recent trace duration"
          subtitle={durations.length ? `Distribution across the latest ${plural(durations.length, 'kept trace')}.` : 'No kept traces in the latest window.'}
        >
          {durations.length ? (
            <Histogram values={durations} formatValue={(v) => ms(v)} ariaLabel="Distribution of recent trace durations" />
          ) : <EmptyState title="No duration samples yet.">Send traffic or start simulated traffic to fill this chart.</EmptyState>}
        </Panel>

        <Panel title="System health" subtitle="Collector-wide checks from the latest metrics snapshot.">
          {checks.length ? (
            <ul className="check-list">
              {checks.map((c) => (
                <li key={c.key} className={`check-item tone-${c.state}`}>
                  <StatusBadge tone={STATE_TONE[c.state] || 'neutral'}>{c.value}</StatusBadge>
                  <div className="check-copy">
                    <span>{c.label}</span>
                    <small>{c.detail}</small>
                  </div>
                </li>
              ))}
            </ul>
          ) : <LoadingSkeleton rows={4} />}
        </Panel>
      </div>
    </>
  );
}
