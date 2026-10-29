'use strict';
// RuntimeConfig: the single source of every tunable value (section 4.3).
// get() is read on every decision/tick so a PUT takes effect immediately.
const { EventEmitter } = require('node:events');

const DEFAULTS = Object.freeze({
  normal_sampling_rate: 0.10,
  error_sampling_rate: 1.00,
  latency_threshold_ms: 2000,
  keep_incomplete_traces: true,
  backpressure_sampling_factor: 0.25,
  trace_timeout_ms: 30000,
  // Must exceed the SDK export interval (BatchSpanProcessor default 5 s) so spans from
  // other services arrive before the trace is closed.
  settle_window_ms: 6000,
  max_spans_per_trace: 1000,
  max_open_traces: 50000,
  queue_soft_limit: 5000,
  queue_hard_limit: 10000,
  batch_flush_size: 500,
  batch_flush_interval_ms: 5000,
  retry_base_ms: 500,
  retry_max_ms: 30000,
  breaker_failure_threshold: 3,
  breaker_cooldown_ms: 10000,
  max_pending_batches: 20,
  hot_retention_days: 7,
  cold_retention_days: 90,
  archive_interval_ms: 60000,
  archive_batch_size: 1000,
});

// type: 'rate' (0..1), 'int', 'num', 'bool'. min/max inclusive unless exclusiveMin.
const SCHEMA = {
  normal_sampling_rate: { type: 'num', min: 0, max: 1 },
  error_sampling_rate: { type: 'num', min: 0, max: 1 },
  latency_threshold_ms: { type: 'int', min: 1, max: 600000 },
  keep_incomplete_traces: { type: 'bool' },
  backpressure_sampling_factor: { type: 'num', min: 0, max: 1 },
  trace_timeout_ms: { type: 'int', min: 1000, max: 600000 },
  settle_window_ms: { type: 'int', min: 50, max: 10000 },
  max_spans_per_trace: { type: 'int', min: 10, max: 10000 },
  max_open_traces: { type: 'int', min: 100, max: 1000000 },
  queue_soft_limit: { type: 'int', min: 1, max: 999999 },
  queue_hard_limit: { type: 'int', min: 2, max: 1000000 },
  batch_flush_size: { type: 'int', min: 1, max: 10000 },
  batch_flush_interval_ms: { type: 'int', min: 100, max: 60000 },
  retry_base_ms: { type: 'int', min: 1, max: 600000 },
  retry_max_ms: { type: 'int', min: 1, max: 600000 },
  breaker_failure_threshold: { type: 'int', min: 1, max: 20 },
  breaker_cooldown_ms: { type: 'int', min: 1000, max: 300000 },
  max_pending_batches: { type: 'int', min: 1, max: 1000 },
  hot_retention_days: { type: 'num', exclusiveMin: 0, max: 36500 },
  cold_retention_days: { type: 'num', exclusiveMin: 0, max: 36500 },
  archive_interval_ms: { type: 'int', min: 1000, max: 3600000 },
  archive_batch_size: { type: 'int', min: 1, max: 50000 },
};

function checkField(key, value) {
  const rule = SCHEMA[key];
  if (!rule) return 'unknown key';
  if (rule.type === 'bool') return typeof value === 'boolean' ? null : 'must be a boolean';
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
  if (rule.type === 'int' && !Number.isInteger(value)) return 'must be an integer';
  if (rule.exclusiveMin !== undefined && !(value > rule.exclusiveMin)) return `must be greater than ${rule.exclusiveMin}`;
  if (rule.min !== undefined && value < rule.min) return `must be >= ${rule.min}`;
  if (rule.max !== undefined && value > rule.max) return `must be <= ${rule.max}`;
  return null;
}

/** Validate a full config object. Returns an array of { field, reason }. */
function validateConfig(cfg) {
  const errors = [];
  for (const key of Object.keys(cfg)) {
    const reason = checkField(key, cfg[key]);
    if (reason) errors.push({ field: key, reason });
  }
  for (const key of Object.keys(SCHEMA)) {
    if (!(key in cfg)) errors.push({ field: key, reason: 'missing' });
  }
  if (errors.length) return errors;
  // Cross-field rules.
  if (cfg.settle_window_ms >= cfg.trace_timeout_ms) {
    errors.push({ field: 'settle_window_ms', reason: 'must be below trace_timeout_ms' });
  }
  if (cfg.queue_soft_limit > cfg.queue_hard_limit - 1) {
    errors.push({ field: 'queue_soft_limit', reason: 'must be at most queue_hard_limit - 1' });
  }
  if (cfg.retry_base_ms >= cfg.retry_max_ms) {
    errors.push({ field: 'retry_base_ms', reason: 'must be below retry_max_ms' });
  }
  if (cfg.cold_retention_days < cfg.hot_retention_days) {
    errors.push({ field: 'cold_retention_days', reason: 'must be at least hot_retention_days' });
  }
  return errors;
}

class ConfigError extends Error {
  constructor(errors) {
    super('invalid config: ' + errors.map((e) => `${e.field} ${e.reason}`).join('; '));
    this.errors = errors;
  }
}

class RuntimeConfig extends EventEmitter {
  constructor(initial = {}, { logger } = {}) {
    super();
    const merged = { ...DEFAULTS, ...initial };
    const errors = validateConfig(merged);
    if (errors.length) throw new ConfigError(errors);
    this._cfg = Object.freeze(merged);
    this.version = 1;
    this.logger = logger;
  }

  get() {
    return this._cfg;
  }

  /**
   * Apply a partial update atomically. The merged result is validated first;
   * on any error nothing changes.
   * @returns {{ok:true, config, version}|{ok:false, status, errors}}
   */
  update(patch, { ifMatch } = {}) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, status: 400, errors: [{ field: '(body)', reason: 'must be a JSON object' }] };
    }
    if (ifMatch !== undefined && ifMatch !== null && String(ifMatch) !== String(this.version)) {
      return { ok: false, status: 409, errors: [{ field: 'If-Match', reason: `stale version, current is ${this.version}` }] };
    }
    const errors = [];
    for (const key of Object.keys(patch)) {
      const reason = checkField(key, patch[key]);
      if (reason) errors.push({ field: key, reason });
    }
    const merged = { ...this._cfg, ...patch };
    if (!errors.length) errors.push(...validateConfig(merged));
    if (errors.length) return { ok: false, status: 400, errors };

    const old = this._cfg;
    const changed = Object.keys(patch).filter((k) => old[k] !== merged[k]);
    this._cfg = Object.freeze(merged);
    this.version += 1;
    for (const key of changed) {
      this.logger?.info?.(`config ${key}: ${old[key]} -> ${merged[key]} (version ${this.version})`);
    }
    this.emit('config:changed', { changed, old, config: this._cfg, version: this.version });
    return { ok: true, config: this._cfg, version: this.version };
  }
}

module.exports = { RuntimeConfig, DEFAULTS, SCHEMA, validateConfig, ConfigError };
