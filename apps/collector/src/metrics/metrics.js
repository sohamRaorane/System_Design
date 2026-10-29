'use strict';
// Counters, rolling rates and latency percentiles (section 5.11), plus the collector's own
// process health (event-loop delay, memory) and a Prometheus text rendering.
const { monitorEventLoopDelay } = require('node:perf_hooks');

/** Rate over the last `windowSec` complete 1-second buckets. */
class RollingRate {
  constructor(clock, windowSec = 5) {
    this.clock = clock;
    this.windowSec = windowSec;
    this.buckets = new Map(); // second -> count
  }

  add(n = 1) {
    const sec = Math.floor(this.clock.now() / 1000);
    this.buckets.set(sec, (this.buckets.get(sec) || 0) + n);
    if (this.buckets.size > this.windowSec * 2) this._prune(sec);
  }

  _prune(nowSec) {
    for (const s of this.buckets.keys()) if (s < nowSec - this.windowSec) this.buckets.delete(s);
  }

  rate() {
    const nowSec = Math.floor(this.clock.now() / 1000);
    this._prune(nowSec);
    let sum = 0;
    for (let s = nowSec - this.windowSec; s < nowSec; s++) sum += this.buckets.get(s) || 0;
    return Math.round((sum / this.windowSec) * 10) / 10;
  }
}

/** Ring buffer of the last N samples with percentile lookup. */
class LatencySamples {
  constructor(size = 1000) {
    this.size = size;
    this.values = [];
    this.next = 0;
  }

  add(v) {
    if (this.values.length < this.size) this.values.push(v);
    else this.values[this.next] = v;
    this.next = (this.next + 1) % this.size;
  }

  percentile(p) {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return Math.round(sorted[Math.max(0, idx)]);
  }
}

function createMetrics(clock) {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  return {
    loop,
    startedAt: clock.mono(),
    ingestRate: new RollingRate(clock, 5),
    finalizeToStored: new LatencySamples(1000),
    c: {
      // ingestion
      spans_received: 0,
      spans_accepted: 0,
      spans_invalid: 0,
      rejected_spans: 0,
      clock_skew_spans: 0,
      requests_by_format: { 'otlp-proto': 0, 'otlp-json': 0, legacy: 0 },
      unauthorized_requests: 0,
      rate_limited_requests: 0,
      ignored_signal_requests: 0,
      // aggregation
      traces_finalized: { hint: 0, settle: 0, timeout: 0, evicted: 0, shutdown: 0 },
      duplicate_spans: 0,
      conflicting_duplicates: 0,
      late_spans: 0,
      late_spans_merged: 0,
      late_spans_dropped: 0,
      late_error_rescued: 0,
      oversized_spans_dropped: 0,
      multi_root_traces: 0,
      // sampling
      kept_total: 0,
      kept_by_reason: { ERROR: 0, HIGH_LATENCY: 0, INCOMPLETE: 0, NORMAL_SAMPLED: 0 },
      dropped_total: 0,
      backpressure_adjusted_decisions: 0,
      // batching
      batches_flushed: 0,
      batch_failures: 0,
      batch_retries: 0,
      shed_during_outage: 0,
      spilled_batches: 0,
      replayed_spill_batches: 0,
      breaker_opened_total: 0,
      // archive
      archived_traces: 0,
      archive_runs: 0,
      archive_failures: 0,
      archive_retries: 0,
      cold_read_errors: 0,
      last_archive_at: null,
    },
  };
}

/** Assemble the /metrics JSON snapshot from counters plus live gauges. */
async function snapshot(m, { queue, aggregator, batch, breaker, repo, config }) {
  const c = m.c;
  const [hot, cold] = await Promise.all([repo.safeCount('hot'), repo.safeCount('cold')]);
  return {
    ingestion: {
      spans_received: c.spans_received,
      spans_accepted: c.spans_accepted,
      spans_invalid: c.spans_invalid,
      rejected_spans: c.rejected_spans,
      ingest_rate_per_sec: m.ingestRate.rate(),
      clock_skew_spans: c.clock_skew_spans,
      requests_by_format: { ...c.requests_by_format },
      unauthorized_requests: c.unauthorized_requests,
      rate_limited_requests: c.rate_limited_requests,
      ignored_signal_requests: c.ignored_signal_requests,
    },
    queue: {
      queue_depth: queue.size,
      queue_high_watermark: queue.highWatermark,
      queue_state: queue.state,
      drain_rate_per_sec: queue.drainRate.rate(),
    },
    aggregation: {
      open_traces: aggregator.openCount,
      traces_finalized: { ...c.traces_finalized },
      duplicate_spans: c.duplicate_spans,
      conflicting_duplicates: c.conflicting_duplicates,
      late_spans: c.late_spans,
      late_spans_merged: c.late_spans_merged,
      late_spans_dropped: c.late_spans_dropped,
      late_error_rescued: c.late_error_rescued,
      oversized_spans_dropped: c.oversized_spans_dropped,
      multi_root_traces: c.multi_root_traces,
      tombstones: aggregator.tombstoneCount,
    },
    sampling: {
      kept_total: c.kept_total,
      kept_by_reason: { ...c.kept_by_reason },
      dropped_total: c.dropped_total,
      backpressure_adjusted_decisions: c.backpressure_adjusted_decisions,
    },
    batching: {
      current_batch_size: batch.currentSize,
      pending_batches: batch.pendingCount,
      batches_flushed: c.batches_flushed,
      batch_failures: c.batch_failures,
      batch_retries: c.batch_retries,
      shed_during_outage: c.shed_during_outage,
      spilled_batches: c.spilled_batches,
      replayed_spill_batches: c.replayed_spill_batches,
      breaker_state: breaker.state,
      breaker_opened_total: c.breaker_opened_total,
    },
    storage: {
      hot_trace_count: hot,
      finalize_to_stored_ms: { p50: m.finalizeToStored.percentile(50), p95: m.finalizeToStored.percentile(95) },
    },
    archive: {
      archived_traces: c.archived_traces,
      cold_trace_count: cold,
      archive_runs: c.archive_runs,
      archive_failures: c.archive_failures,
      archive_retries: c.archive_retries,
      cold_read_errors: c.cold_read_errors,
      last_archive_at: c.last_archive_at,
    },
    config_version: config.version,
    uptime_s: Math.round((performance.now() - m.startedAt) / 1000),
    memory_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    process: processStats(m),
  };
}

/** The collector watching itself: is the event loop keeping up, how much memory is used. */
function processStats(m) {
  const mem = process.memoryUsage();
  const ns = (v) => (Number.isFinite(v) ? Math.round(v / 1e4) / 100 : null); // ns -> ms, 2 dp
  const out = {
    event_loop_delay_ms: { p50: ns(m.loop?.percentile(50)), p99: ns(m.loop?.percentile(99)), max: ns(m.loop?.max) },
    heap_used_mb: Math.round(mem.heapUsed / 1048576),
    rss_mb: Math.round(mem.rss / 1048576),
    node_version: process.version,
  };
  m.loop?.reset();
  return out;
}

/** Flatten a snapshot into Prometheus text exposition format (counters and gauges). */
function toPrometheus(snap) {
  const lines = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = `${prefix}_${k}`.replace(/[^a-zA-Z0-9_]/g, '_');
      if (typeof v === 'number' && Number.isFinite(v)) lines.push(`${name} ${v}`);
      else if (typeof v === 'boolean') lines.push(`${name} ${v ? 1 : 0}`);
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, name);
    }
  };
  walk(snap, 'tracepipe');
  const states = { queue_state: snap.queue.queue_state, breaker_state: snap.batching.breaker_state };
  lines.push(`tracepipe_queue_state{state="${states.queue_state}"} 1`);
  lines.push(`tracepipe_breaker_state{state="${states.breaker_state}"} 1`);
  return lines.join('\n') + '\n';
}

module.exports = { createMetrics, snapshot, toPrometheus, RollingRate, LatencySamples };
