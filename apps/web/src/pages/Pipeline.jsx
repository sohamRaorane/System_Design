import { useMemo, useState } from 'react';
import { ago, duration, ms, num, pct } from '../lib/format.js';
import { headline, pipelineChecks, pipelineStages } from '../lib/health.js';
import { METRIC_CATALOG, RANGES, withinRange, usePipeline } from '../lib/pipeline.js';
import { LineChart, Sparkline } from '../components/charts.jsx';
import {
  EmptyState, ErrorNotice, KeyValue, LoadingSkeleton, MetricCard, PageHeader, Panel, StatusBadge, TimeRange,
} from '../components/ui.jsx';

const STATE_TONE = { ok: 'ok', warn: 'warn', bad: 'bad', idle: 'idle' };
const GROUPS = [...new Set(METRIC_CATALOG.map((m) => m.group))];

function metricFormat(unit) {
  if (unit === 'ms') return (v) => ms(v);
  if (unit === 'MB') return (v) => `${num(v)} MB`;
  return (v) => num(v);
}

function CounterTable({ rows }) {
  return (
    <div className="table-wrap">
      <table className="simple data-table">
        <thead><tr><th>Counter</th><th className="num">Value</th></tr></thead>
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}><td>{label}</td><td className="num">{value}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pipeline() {
  const pipeline = usePipeline();
  const [rangeKey, setRangeKey] = useState('5m');
  const [metricKey, setMetricKey] = useState('ingestRate');
  const range = RANGES.find((r) => r.key === rangeKey) || RANGES[1];
  const history = useMemo(() => withinRange(pipeline.history, range.ms), [pipeline.history, range.ms]);
  const stages = useMemo(() => pipelineStages(pipeline.data, pipeline.prev), [pipeline.data, pipeline.prev]);
  const head = headline(stages, pipeline.data);
  const checks = useMemo(() => pipelineChecks(pipeline.data), [pipeline.data]);
  const m = pipeline.data;
  const metric = METRIC_CATALOG.find((x) => x.key === metricKey) || METRIC_CATALOG[0];
  const metricSeries = history.map((h) => ({ t: h.t, v: metric.pick(h) })).filter((p) => p.v !== null && p.v !== undefined);
  const currentMetric = metricSeries.length ? metricSeries[metricSeries.length - 1].v : null;
  const fmt = metricFormat(metric.unit);

  const keptTotal = (m?.sampling.kept_total || 0) + (m?.sampling.dropped_total || 0);
  const keptPct = keptTotal ? (m.sampling.kept_total / keptTotal) : null;

  const throughputSeries = [{ key: 'ingest', label: 'Ingest rate', color: 'var(--accent)', points: history.map((h) => ({ t: h.t, v: h.ingestRate })) }];
  const queueSeries = [
    { key: 'queue', label: 'Queue depth', color: 'var(--accent)', points: history.map((h) => ({ t: h.t, v: h.queueDepth })) },
    { key: 'open', label: 'Open traces', color: 'var(--purple)', points: history.map((h) => ({ t: h.t, v: h.openTraces })) },
  ];
  const latencySeries = [
    { key: 'p50', label: 'p50', color: 'var(--green)', points: history.map((h) => ({ t: h.t, v: h.storageP50 })) },
    { key: 'p95', label: 'p95', color: 'var(--amber)', points: history.map((h) => ({ t: h.t, v: h.storageP95 })) },
  ];
  const memSeries = [{ key: 'rss', label: 'Resident memory', color: 'var(--purple)', points: history.map((h) => ({ t: h.t, v: h.memoryRss })) }];
  const loopSeries = [{ key: 'loop', label: 'Event loop p99', color: 'var(--amber)', points: history.map((h) => ({ t: h.t, v: h.loopP99 })) }];

  const ingestionRows = m ? [
    ['Spans received', num(m.ingestion.spans_received)],
    ['Spans accepted', num(m.ingestion.spans_accepted)],
    ['Invalid spans', num(m.ingestion.spans_invalid)],
    ['Rejected (queue full)', num(m.ingestion.rejected_spans)],
    ['Unauthorized requests', num(m.ingestion.unauthorized_requests)],
    ['Rate-limited requests', num(m.ingestion.rate_limited_requests)],
    ['Ignored signals (metrics/logs)', num(m.ingestion.ignored_signal_requests)],
    ['Clock-skew spans', num(m.ingestion.clock_skew_spans)],
  ] : [];

  const assemblyRows = m ? [
    ['Traces finalized by hint', num(m.aggregation.traces_finalized.hint)],
    ['Finalized by settle window', num(m.aggregation.traces_finalized.settle)],
    ['Finalized by timeout', num(m.aggregation.traces_finalized.timeout)],
    ['Finalized by shutdown', num(m.aggregation.traces_finalized.shutdown)],
    ['Duplicate spans dropped', num(m.aggregation.duplicate_spans)],
    ['Late spans merged', num(m.aggregation.late_spans_merged)],
    ['Late spans dropped', num(m.aggregation.late_spans_dropped)],
    ['Late errors rescued', num(m.aggregation.late_error_rescued)],
    ['Multi-root traces', num(m.aggregation.multi_root_traces)],
  ] : [];

  const storageRows = m ? [
    ['Batches flushed', num(m.batching.batches_flushed)],
    ['Batch failures', num(m.batching.batch_failures)],
    ['Batch retries', num(m.batching.batch_retries)],
    ['Shed during outage', num(m.batching.shed_during_outage)],
    ['Spilled batches', num(m.batching.spilled_batches)],
    ['Replayed spill batches', num(m.batching.replayed_spill_batches)],
    ['Breaker opened (total)', num(m.batching.breaker_opened_total)],
    ['Archive runs', num(m.archive.archive_runs)],
    ['Archive failures', num(m.archive.archive_failures)],
    ['Cold read errors', num(m.archive.cold_read_errors)],
  ] : [];

  const samplingRows = m ? [
    ['Traces kept', num(m.sampling.kept_total)],
    ['Healthy traces skipped', num(m.sampling.dropped_total)],
    ['Backpressure-adjusted decisions', num(m.sampling.backpressure_adjusted_decisions)],
    ['Kept: errors', num(m.sampling.kept_by_reason.ERROR)],
    ['Kept: high latency', num(m.sampling.kept_by_reason.HIGH_LATENCY)],
    ['Kept: incomplete', num(m.sampling.kept_by_reason.INCOMPLETE)],
    ['Kept: normal sample', num(m.sampling.kept_by_reason.NORMAL_SAMPLED)],
  ] : [];

  return (
    <>
      <PageHeader
        eyebrow="Collector-wide"
        title="Pipeline"
        description="Metrics from the running collector across every project: throughput, saturation, storage latency and process health. Collected from the application's own /api/pipeline snapshot."
        actions={(
          <>
            <TimeRange value={rangeKey} onChange={setRangeKey} ranges={RANGES} label="Chart time range" />
            <StatusBadge tone={STATE_TONE[head.state] || 'neutral'} pulse={head.state === 'ok'}>
              {head.state === 'ok' ? 'Healthy' : head.state === 'warn' ? 'Warning' : head.state === 'bad' ? 'Critical' : 'Idle'}
            </StatusBadge>
          </>
        )}
      />

      <ErrorNotice error={pipeline.error && !pipeline.data ? pipeline.error : null} />

      {!m && pipeline.loading ? <LoadingSkeleton rows={5} label="Loading pipeline metrics" /> : null}

      {m ? (
        <>
          <section className={`status-banner tone-${head.state}`} role="status" aria-live="polite">
            <span className={`status-orb tone-${head.state}`} aria-hidden="true" />
            <div className="status-banner-text"><b>{head.text}</b><span>{head.detail}</span></div>
            <div className="status-banner-meta">
              <span>uptime {duration(m.uptime_s)}</span>
              <span>config v{m.config_version}</span>
            </div>
          </section>

          <div className="metric-grid">
            <MetricCard label="Ingest rate" value={num(m.ingestion.ingest_rate_per_sec)} unit="spans/s" hint="Rolling five-second average" tone="info" spark={<Sparkline points={history.map((h) => ({ t: h.t, v: h.ingestRate }))} color="var(--accent)" />} />
            <MetricCard label="Queue depth" value={num(m.queue.queue_depth)} unit="spans" hint={`${m.queue.queue_state} · drain ${num(m.queue.drain_rate_per_sec)}/s`} tone={m.queue.queue_state === 'FULL' ? 'bad' : m.queue.queue_state === 'SOFT' ? 'warn' : 'ok'} />
            <MetricCard label="Open traces" value={num(m.aggregation.open_traces)} unit="assembling" hint={`${num(m.aggregation.tombstones)} tombstones`} tone="neutral" />
            <MetricCard label="Kept share" value={keptPct === null ? '–' : `${Math.round(keptPct * 1000) / 10}%`} unit="of decided" hint={`${num(m.sampling.kept_total)} kept · ${num(m.sampling.dropped_total)} skipped`} tone="neutral" />
            <MetricCard label="Hot traces" value={num(m.storage.hot_trace_count)} unit="stored" hint="Searchable in the database" tone="neutral" />
            <MetricCard label="Cold traces" value={num(m.archive.cold_trace_count)} unit="archived" hint={m.archive.last_archive_at ? `Last run ${ago(m.archive.last_archive_at)}` : 'No archive run yet'} tone="neutral" />
            <MetricCard label="Store latency" value={m.storage.finalize_to_stored_ms.p95 === null ? '–' : ms(m.storage.finalize_to_stored_ms.p95)} unit="p95" hint={`p50 ${ms(m.storage.finalize_to_stored_ms.p50)}`} tone={m.batching.breaker_state === 'open' ? 'bad' : 'neutral'} />
            <MetricCard label="Resident memory" value={num(m.process.rss_mb)} unit="MB" hint={`Heap ${num(m.process.heap_used_mb)} MB`} tone="neutral" />
          </div>

          <div className="dash-grid dash-grid-2">
            <Panel title="Ingest throughput" subtitle={`${range.label} window · sampled every 2 s`} actions={<span className="panel-tag">{history.length} samples</span>}>
              {history.length ? <LineChart series={throughputSeries} formatValue={num} area ariaLabel="Collector ingest rate over time" /> : <LoadingSkeleton rows={3} />}
            </Panel>
            <Panel title="Queue and in-flight traces" subtitle="Saturation before senders are refused.">
              {history.length ? <LineChart series={queueSeries} formatValue={num} ariaLabel="Queue depth and open traces over time" /> : <LoadingSkeleton rows={3} />}
            </Panel>
          </div>

          <div className="dash-grid dash-grid-3">
            <Panel title="Storage latency" subtitle="Finalize to successful write.">
              {history.length ? <LineChart series={latencySeries} formatValue={ms} ariaLabel="Storage latency percentiles" /> : <LoadingSkeleton rows={3} />}
            </Panel>
            <Panel title="Process memory" subtitle="Resident set size of the collector.">
              {history.length ? <LineChart series={memSeries} formatValue={(v) => `${num(v)} MB`} ariaLabel="Collector resident memory" /> : <LoadingSkeleton rows={3} />}
            </Panel>
            <Panel title="Event-loop delay" subtitle="p99 delay is a Node.js saturation signal.">
              {history.length ? <LineChart series={loopSeries} formatValue={ms} ariaLabel="Collector event loop p99 delay" /> : <LoadingSkeleton rows={3} />}
            </Panel>
          </div>

          <div className="dash-grid dash-grid-2-1">
            <Panel
              title="Metric explorer"
              subtitle="Pick a metric sampled by this browser session. This is not PromQL; the application exposes snapshots, not a query language."
              actions={(
                <label className="filter-field inline">
                  <span className="sr-only">Metric</span>
                  <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)} aria-label="Metric">
                    {GROUPS.map((g) => (
                      <optgroup key={g} label={g}>
                        {METRIC_CATALOG.filter((x) => x.group === g).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </label>
              )}
            >
              <div className="metric-explorer-head">
                <div>
                  <span className="eyebrow">{metric.group}</span>
                  <h3>{metric.label}</h3>
                  <p className="small muted">{metric.description}</p>
                </div>
                <div className="metric-explorer-value">
                  <strong>{currentMetric === null ? '–' : fmt(currentMetric)}</strong>
                  <span>{metric.unit}</span>
                </div>
              </div>
              {metricSeries.length ? (
                <LineChart series={[{ key: metric.key, label: metric.label, color: 'var(--accent)', points: metricSeries }]} formatValue={fmt} area ariaLabel={`${metric.label} over time`} />
              ) : <EmptyState title="No samples for this metric yet.">Leave the dashboard open; history is collected in this browser.</EmptyState>}
            </Panel>

            <Panel title="Operational checks" subtitle="Derived from the latest snapshot.">
              <ul className="check-list">
                {checks.map((c) => (
                  <li key={c.key} className={`check-item tone-${c.state}`}>
                    <StatusBadge tone={STATE_TONE[c.state] || 'neutral'}>{c.value}</StatusBadge>
                    <div className="check-copy"><span>{c.label}</span><small>{c.detail}</small></div>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>

          <div className="dash-grid dash-grid-2">
            <Panel title="Ingestion and assembly" subtitle="Cumulative counters since the collector started.">
              <CounterTable rows={ingestionRows} />
              <h3 className="subhead">Assembly</h3>
              <CounterTable rows={assemblyRows} />
            </Panel>
            <Panel title="Sampling, writes and archive" subtitle="Cumulative counters since the collector started.">
              <CounterTable rows={samplingRows} />
              <h3 className="subhead">Writes and archive</h3>
              <CounterTable rows={storageRows} />
            </Panel>
          </div>

          <Panel title="Collector process" subtitle="The collector watching itself.">
            <KeyValue
              items={[
                ['Node.js', m.process.node_version],
                ['Uptime', duration(m.uptime_s)],
                ['Resident memory', `${num(m.process.rss_mb)} MB`],
                ['Heap used', `${num(m.process.heap_used_mb)} MB`],
                ['Event loop p50', `${m.process.event_loop_delay_ms.p50 ?? '–'} ms`],
                ['Event loop p99', `${m.process.event_loop_delay_ms.p99 ?? '–'} ms`],
                ['Event loop max', `${m.process.event_loop_delay_ms.max ?? '–'} ms`],
                ['Config version', String(m.config_version)],
                ['Kept share', keptPct === null ? '–' : pct(m.sampling.kept_total, keptTotal)],
              ]}
            />
          </Panel>
        </>
      ) : null}
    </>
  );
}
