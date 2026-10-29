'use strict';
// Batch processor (section 5.6): size/interval flush, single in-order async writer,
// retry with backoff, circuit breaker, outage shedding and disk spill.
const fs = require('node:fs');
const path = require('node:path');
const { backoffDelay, unref } = require('../util/common');

class BatchProcessor {
  constructor({ config, clock, metrics, repo, breaker, faults, spillDir, logger, rng = Math.random }) {
    this.config = config;
    this.clock = clock;
    this.metrics = metrics;
    this.repo = repo;
    this.breaker = breaker;
    this.faults = faults;
    this.spillDir = spillDir;
    this.logger = logger;
    this.rng = rng;
    this.current = [];
    this.pending = []; // [{ traces, attempt }]
    this.flushTimer = null;
    this.retryTimer = null;
    this.writing = null; // Promise of the running writer loop
    this.stopped = true;
    this.spillSeq = 0;
    this.listeners = new Set(); // called with each stored batch (first-trace detection, UI)
    config.on('config:changed', (e) => {
      if (!this.stopped && e.changed.includes('batch_flush_interval_ms')) this._armFlushTimer();
    });
  }

  get currentSize() {
    return this.current.length;
  }

  get pendingCount() {
    return this.pending.length;
  }

  onStored(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start() {
    this.stopped = false;
    this._armFlushTimer();
    this._cleanSpillTmp();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.flushTimer);
    clearTimeout(this.retryTimer);
    this.flushTimer = this.retryTimer = null;
  }

  _armFlushTimer() {
    clearTimeout(this.flushTimer);
    this.flushTimer = unref(setTimeout(() => this.flush(), this.config.get().batch_flush_interval_ms));
  }

  add(trace) {
    this.current.push(trace);
    if (this.current.length >= this.config.get().batch_flush_size) this.flush();
  }

  /**
   * Move the current batch to the tail of pending and kick the writer. Timer resets (E41).
   * Returns the writer promise so callers (tests, admin flush) can await the write.
   */
  flush() {
    if (!this.stopped) this._armFlushTimer();
    if (this.current.length) {
      this.pending.push({ traces: this.current, attempt: 0 });
      this.current = [];
      this._enforceMemoryBound();
    }
    return this._pump();
  }

  /** Start the writer loop if it is not running. Resolves when the loop stops. */
  _pump() {
    if (this.writing) return this.writing;
    if (!this.pending.length) return Promise.resolve();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.writing = this._writeLoop().finally(() => {
      this.writing = null;
    });
    return this.writing;
  }

  async _writeLoop() {
    // Always write the head, so batches are stored in order, one at a time (E40).
    while (this.pending.length) {
      if (!this.breaker.canAttempt()) {
        this._scheduleRetry(this.breaker.msUntilHalfOpen() + 1);
        return;
      }
      const head = this.pending[0];
      try {
        const storedAt = await this.repo.insertBatch(head.traces);
        if (this.pending[0] === head) this.pending.shift();
        this.breaker.onSuccess();
        this.metrics.c.batches_flushed++;
        const mono = this.clock.mono();
        for (const t of head.traces) {
          t.stored_at = storedAt;
          if (t._finMono !== undefined) this.metrics.finalizeToStored.add(Math.max(0, mono - t._finMono));
        }
        for (const fn of this.listeners) {
          try { fn(head.traces); } catch (err) { this.logger?.warn?.('stored listener failed:', err.message); }
        }
      } catch (err) {
        head.attempt++;
        this.breaker.onFailure();
        this.metrics.c.batch_failures++;
        this.metrics.c.batch_retries++;
        const cfg = this.config.get();
        this.logger?.warn?.(`batch write failed (attempt ${head.attempt}): ${err.message}`);
        this._scheduleRetry(backoffDelay(head.attempt, cfg.retry_base_ms, cfg.retry_max_ms, this.rng));
        return;
      }
    }
    this._replaySpill();
  }

  _scheduleRetry(ms) {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = unref(setTimeout(() => {
      this.retryTimer = null;
      this._pump();
    }, ms));
  }

  /** Bound memory during long outages: shed NORMAL traces first, then spill (E42). */
  _enforceMemoryBound() {
    const max = this.config.get().max_pending_batches;
    if (this.pending.length <= max) return;
    // Never touch the head while a write of it may be in flight.
    const start = this.writing ? 1 : 0;
    for (let i = start; i < this.pending.length && this.pending.length > max; i++) {
      const batch = this.pending[i];
      const before = batch.traces.length;
      batch.traces = batch.traces.filter((t) => t.sample_reason !== 'NORMAL_SAMPLED');
      this.metrics.c.shed_during_outage += before - batch.traces.length;
    }
    this.pending = this.pending.filter((b, i) => i < start || b.traces.length);
    while (this.pending.length > max && this.pending.length > start) {
      const [oldest] = this.pending.splice(start, 1);
      if (!this._spill(oldest)) {
        this.pending.splice(start, 0, oldest);
        break;
      }
    }
  }

  _spill(batch) {
    if (!this.spillDir) {
      this.logger?.error?.('pending bound exceeded and no spill dir; keeping batch in memory');
      return false;
    }
    try {
      fs.mkdirSync(this.spillDir, { recursive: true });
      const file = path.join(this.spillDir, `spill-${this.clock.now()}-${String(this.spillSeq++).padStart(6, '0')}.jsonl`);
      fs.writeFileSync(file + '.tmp', batch.traces.map((t) => JSON.stringify(t)).join('\n') + '\n');
      fs.renameSync(file + '.tmp', file);
      this.metrics.c.spilled_batches++;
      return true;
    } catch (err) {
      this.logger?.error?.('spill failed, keeping batch in memory:', err.message);
      return false;
    }
  }

  _cleanSpillTmp() {
    if (!this.spillDir || !fs.existsSync(this.spillDir)) return;
    for (const f of fs.readdirSync(this.spillDir)) if (f.endsWith('.tmp')) fs.rmSync(path.join(this.spillDir, f));
  }

  /** Replay spill files once pending has drained (breaker is closed at that point). */
  _replaySpill() {
    if (!this.spillDir || !fs.existsSync(this.spillDir) || this.breaker.state !== 'closed') return;
    const files = fs.readdirSync(this.spillDir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files) {
      const full = path.join(this.spillDir, f);
      const traces = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      this.pending.push({ traces, attempt: 0 });
      fs.rmSync(full);
      this.metrics.c.replayed_spill_batches++;
    }
    if (files.length) setImmediate(() => this._pump());
  }

  findPending(projectId, traceId) {
    const match = (t) => t.trace_id === traceId && (t.project_id || 'default') === projectId;
    for (const t of this.current) if (match(t)) return t;
    for (const b of this.pending) for (const t of b.traces) if (match(t)) return t;
    return null;
  }

  /** Graceful shutdown: flush and try to write everything once. Resolves true if nothing is left. */
  async drainAll() {
    if (this.current.length) {
      this.pending.push({ traces: this.current, attempt: 0 });
      this.current = [];
    }
    if (this.writing) await this.writing;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    // Ignore backoff on shutdown but respect the breaker's refusal to write.
    while (this.pending.length && this.breaker.canAttempt()) {
      const head = this.pending[0];
      try {
        const storedAt = await this.repo.insertBatch(head.traces);
        for (const t of head.traces) t.stored_at = storedAt;
        this.pending.shift();
        this.metrics.c.batches_flushed++;
      } catch (err) {
        this.breaker.onFailure();
        this.metrics.c.batch_failures++;
        this.logger?.error?.('shutdown flush failed:', err.message);
        break;
      }
    }
    return this.pending.length === 0;
  }
}

module.exports = { BatchProcessor };
