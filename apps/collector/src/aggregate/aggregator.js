'use strict';
// Trace aggregator (section 5.3): Map<trace_id, Entry>, timers, dedup, tombstones.
const { evaluate, readHint } = require('./completeness');
const { buildTrace } = require('./traceBuilder');
const { stableStringify, unref } = require('../util/common');

const TOMBSTONE_SWEEP_MS = 5000;
const TOMBSTONE_MIN_TTL_MS = 60000;
const MAX_TOMBSTONES = 200000;

/** Traces are isolated per project: the same trace_id in two projects never merges. */
const keyOf = (projectId, traceId) => (projectId || 'default') + '\0' + traceId;

class Aggregator {
  constructor({ config, clock, metrics, sampler, sink, logger }) {
    this.config = config;
    this.clock = clock;
    this.metrics = metrics;
    this.sampler = sampler;
    this.sink = sink; // { add(trace) }
    this.logger = logger;
    this.open = new Map(); // key(project, trace) -> Entry
    this.tombstones = new Map(); // key(project, trace) -> { spanIds:Set, expiresAt, kept, reason }
    this.sweepTimer = null;
  }

  get openCount() {
    return this.open.size;
  }

  get tombstoneCount() {
    return this.tombstones.size;
  }

  start() {
    if (this.sweepTimer) return;
    this.sweepTimer = unref(setInterval(() => this.sweepTombstones(), TOMBSTONE_SWEEP_MS));
  }

  stop() {
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  addSpan(span) {
    const c = this.metrics.c;
    const cfg = this.config.get();

    // 1. Tombstone check: the trace was finalized recently.
    const key = keyOf(span.project_id, span.trace_id);
    const tomb = this.tombstones.get(key);
    if (tomb) {
      if (tomb.expiresAt > this.clock.now()) {
        if (tomb.spanIds.has(span.span_id)) c.duplicate_spans++;
        else c.late_spans++;
        return;
      }
      this.tombstones.delete(key);
    }

    // 2. Get or create the entry.
    let entry = this.open.get(key);
    if (!entry) {
      if (this.open.size >= cfg.max_open_traces) {
        const oldest = this.open.values().next().value;
        this.finalize(oldest, 'evicted');
      }
      entry = {
        key,
        projectId: span.project_id || 'default',
        traceId: span.trace_id,
        spans: new Map(),
        firstSeenAt: this.clock.now(),
        lastSpanAt: this.clock.now(),
        rootSpanId: null,
        expectedSpans: null,
        timeoutTimer: null,
        settleTimer: null,
        truncated: false,
      };
      // Deadline is fixed at creation; later config changes affect new traces only (E25).
      entry.timeoutTimer = unref(setTimeout(() => this.finalize(entry, 'timeout'), cfg.trace_timeout_ms));
      this.open.set(key, entry);
    }

    // 3. Duplicate check (key is the pair trace_id + span_id, E20).
    const existing = entry.spans.get(span.span_id);
    if (existing) {
      c.duplicate_spans++;
      if (stableStringify(existing) !== stableStringify(span)) c.conflicting_duplicates++;
      return;
    }

    // 4. Size cap.
    if (entry.spans.size >= cfg.max_spans_per_trace) {
      c.oversized_spans_dropped++;
      entry.truncated = true;
      return;
    }

    // 5. Add the span.
    entry.spans.set(span.span_id, span);
    entry.lastSpanAt = this.clock.now();
    if (!span.parent_span_id) {
      if (!entry.rootSpanId) {
        entry.rootSpanId = span.span_id;
        entry.expectedSpans = readHint(span);
      } else {
        c.multi_root_traces++;
      }
    }

    // 6. Completeness.
    const verdict = evaluate(entry);
    if (verdict === 'hint') {
      this.finalize(entry, 'hint');
    } else if (verdict === 'structure') {
      clearTimeout(entry.settleTimer);
      entry.settleTimer = unref(setTimeout(() => this.finalize(entry, 'settle'), cfg.settle_window_ms));
    } else if (entry.settleTimer) {
      clearTimeout(entry.settleTimer);
      entry.settleTimer = null;
    }
  }

  finalize(entry, cause) {
    if (this.open.get(entry.key) !== entry) return; // already finalized
    clearTimeout(entry.timeoutTimer);
    clearTimeout(entry.settleTimer);
    this.open.delete(entry.key);

    const verdict = evaluate(entry);
    const isComplete = (cause === 'hint' || cause === 'settle') && verdict !== 'none';
    const trace = buildTrace([...entry.spans.values()], {
      project_id: entry.projectId,
      trace_id: entry.traceId,
      rootSpanId: entry.rootSpanId,
      is_complete: isComplete,
      truncated: entry.truncated,
      created_at: entry.firstSeenAt,
      finalized_at: this.clock.now(),
    });
    // Monotonic timestamp for the finalize-to-stored latency metric (not serialized).
    Object.defineProperty(trace, '_finMono', { value: this.clock.mono(), enumerable: false, writable: true });

    this.metrics.c.traces_finalized[cause] = (this.metrics.c.traces_finalized[cause] || 0) + 1;

    const decision = this.sampler.decide(trace);
    this._writeTombstone(entry, decision);
    if (decision.keep) {
      trace.sampled = true;
      trace.sample_reason = decision.reason;
      this.sink.add(trace);
    }
    this.onFinalized?.(trace, decision);
    return trace;
  }

  _writeTombstone(entry, decision = { keep: false, reason: null }) {
    const ttl = Math.max(2 * this.config.get().trace_timeout_ms, TOMBSTONE_MIN_TTL_MS);
    this.tombstones.delete(entry.key); // re-insert at the end (newest)
    this.tombstones.set(entry.key, {
      spanIds: new Set(entry.spans.keys()),
      expiresAt: this.clock.now() + ttl,
      kept: decision.keep,
      reason: decision.reason,
    });
    while (this.tombstones.size > MAX_TOMBSTONES) {
      this.tombstones.delete(this.tombstones.keys().next().value);
    }
  }

  sweepTombstones() {
    const now = this.clock.now();
    for (const [id, t] of this.tombstones) if (t.expiresAt <= now) this.tombstones.delete(id);
  }

  /** Partial view of an open trace, for GET /v1/traces/:id (source: in_flight). */
  peek(projectId, traceId) {
    const entry = this.open.get(keyOf(projectId, traceId));
    if (!entry) return null;
    return buildTrace([...entry.spans.values()], {
      project_id: entry.projectId,
      trace_id: entry.traceId,
      rootSpanId: entry.rootSpanId,
      is_complete: false,
      truncated: entry.truncated,
      created_at: entry.firstSeenAt,
      finalized_at: null,
    });
  }

  /** Finalize every open trace (graceful shutdown). */
  finalizeAll(cause = 'shutdown') {
    for (const entry of [...this.open.values()]) this.finalize(entry, cause);
  }
}

module.exports = { Aggregator, keyOf };
