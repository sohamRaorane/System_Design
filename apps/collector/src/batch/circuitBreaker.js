'use strict';
// closed -> (N consecutive failures) -> open -> (cooldown) -> half_open -> success: closed / failure: open.

class CircuitBreaker {
  constructor({ config, clock, metrics, logger }) {
    this.config = config;
    this.clock = clock;
    this.metrics = metrics;
    this.logger = logger;
    this._state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  /** Lazily moves open -> half_open once the cooldown has elapsed. */
  get state() {
    if (this._state === 'open' && this.msUntilHalfOpen() === 0) this._state = 'half_open';
    return this._state;
  }

  msUntilHalfOpen() {
    if (this._state !== 'open') return 0;
    return Math.max(0, this.openedAt + this.config.get().breaker_cooldown_ms - this.clock.now());
  }

  canAttempt() {
    return this.state !== 'open';
  }

  onSuccess() {
    if (this._state !== 'closed') this.logger?.info?.('circuit breaker closed');
    this._state = 'closed';
    this.failures = 0;
  }

  onFailure() {
    const state = this.state;
    this.failures++;
    if (state === 'half_open' || (state === 'closed' && this.failures >= this.config.get().breaker_failure_threshold)) {
      this._state = 'open';
      this.openedAt = this.clock.now();
      this.metrics.c.breaker_opened_total++;
      this.logger?.warn?.(`circuit breaker opened (${this.failures} consecutive failures)`);
    }
  }
}

module.exports = { CircuitBreaker };
