'use strict';
// Tail-based sampler (section 5.5). Decisions are a deterministic hash of trace_id,
// so the same id always gets the same decision (in tests and across replicas).
const crypto = require('node:crypto');

const REASONS = ['ERROR', 'HIGH_LATENCY', 'INCOMPLETE', 'NORMAL_SAMPLED'];

/** First 8 hex chars of SHA-1(trace_id) / 2^32, in [0, 1). */
function hashToUnit(traceId) {
  const hex = crypto.createHash('sha1').update(String(traceId)).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 4294967296;
}

class Sampler {
  constructor({ config, queue, metrics, hash = hashToUnit, overrides }) {
    this.config = config;
    this.overrides = overrides; // (projectId) -> per-project settings, or undefined
    this.queue = queue; // { state }
    this.metrics = metrics;
    this.hash = hash;
  }

  decide(trace) {
    const base = this.config.get();
    const o = this.overrides?.(trace.project_id);
    const cfg = o ? { ...base, ...o } : base;
    const c = this.metrics.c;
    const u = this.hash(trace.trace_id);
    const keep = (reason) => {
      c.kept_total++;
      c.kept_by_reason[reason]++;
      return { keep: true, reason };
    };

    if (trace.status === 'ERROR' && u < cfg.error_sampling_rate) return keep('ERROR');
    if (trace.duration_ms > cfg.latency_threshold_ms) return keep('HIGH_LATENCY');
    if (!trace.is_complete && cfg.keep_incomplete_traces) return keep('INCOMPLETE');

    let rate = cfg.normal_sampling_rate;
    if (this.queue && this.queue.state !== 'NORMAL') {
      rate *= cfg.backpressure_sampling_factor;
      c.backpressure_adjusted_decisions++;
    }
    if (u < rate) return keep('NORMAL_SAMPLED');
    c.dropped_total++;
    return { keep: false, reason: null };
  }
}

const REASON_PRIORITY = { ERROR: 4, HIGH_LATENCY: 3, INCOMPLETE: 2, NORMAL_SAMPLED: 1 };

module.exports = { Sampler, hashToUnit, REASONS, REASON_PRIORITY };
