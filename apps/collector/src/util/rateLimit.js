'use strict';
// Token-bucket rate limiter keyed by any string (project id, client IP). Memory is bounded:
// idle buckets are forgotten and the map never exceeds maxKeys.

class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.ratePerSec   sustained rate
   * @param {number} o.burst        bucket size
   */
  constructor({ ratePerSec, burst, clock = { now: () => Date.now() }, maxKeys = 50_000 }) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.clock = clock;
    this.maxKeys = maxKeys;
    this.buckets = new Map(); // key -> { tokens, at }
  }

  /** Take `cost` tokens. Returns { ok, retryAfterS }. */
  take(key, cost = 1) {
    const now = this.clock.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this._sweep(now, true);
      b = { tokens: this.burst, at: now };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.rate);
      b.at = now;
    }
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((cost - b.tokens) / this.rate)) };
  }

  _sweep(now, force) {
    const idleMs = (this.burst / this.rate) * 1000 + 60_000;
    for (const [k, b] of this.buckets) if (now - b.at > idleMs) this.buckets.delete(k);
    if (force && this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
  }
}

/** Express middleware limiting by client IP (req.ip honours `trust proxy`). */
function limitByIp(limiter, { message = 'Too many requests. Wait a moment and try again.' } = {}) {
  return (req, res, next) => {
    const v = limiter.take(req.ip || 'unknown');
    if (v.ok) return next();
    res.set('Retry-After', String(v.retryAfterS));
    res.status(429).json({ error: 'rate_limited', message, retry_after_s: v.retryAfterS });
  };
}

module.exports = { RateLimiter, limitByIp };
