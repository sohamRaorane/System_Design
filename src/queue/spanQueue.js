'use strict';
// Bounded FIFO between ingestion and the aggregator (section 5.2).
// Array + moving head index (Array.shift is O(n)); compacts when head passes half.
const { RollingRate } = require('../metrics/metrics');

const SPANS_PER_TICK = 500;
const SLOW_SPANS_PER_TICK = 5;
const SLOW_TICK_DELAY_MS = 20;

class SpanQueue {
  constructor({ config, faults, clock, consumer, logger }) {
    this.config = config;
    this.faults = faults;
    this.consumer = consumer; // (span) => void
    this.logger = logger;
    this.items = [];
    this.head = 0;
    this.highWatermark = 0;
    this.drainRate = new RollingRate(clock, 5);
    this.running = false;
    this.scheduled = false;
  }

  get size() {
    return this.items.length - this.head;
  }

  /** NORMAL below the soft limit, SOFT between, FULL at the hard limit. */
  get state() {
    const { queue_soft_limit, queue_hard_limit } = this.config.get();
    const n = this.size;
    if (n >= queue_hard_limit) return 'FULL';
    if (n >= queue_soft_limit) return 'SOFT';
    return 'NORMAL';
  }

  push(spans) {
    for (const s of spans) this.items.push(s);
    if (this.size > this.highWatermark) this.highWatermark = this.size;
    this._schedule();
  }

  start() {
    this.running = true;
    this._schedule();
  }

  stop() {
    this.running = false;
  }

  _take(max) {
    const end = Math.min(this.items.length, this.head + max);
    const out = this.items.slice(this.head, end);
    for (let i = this.head; i < end; i++) this.items[i] = undefined;
    this.head = end;
    if (this.head === this.items.length) {
      this.items = [];
      this.head = 0;
    } else if (this.head > 1024 && this.head > this.items.length / 2) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return out;
  }

  _schedule(delayMs = 0) {
    if (!this.running || this.scheduled || this.size === 0) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      this._tick();
    };
    if (delayMs > 0) setTimeout(run, delayMs);
    else setImmediate(run);
  }

  _tick() {
    if (!this.running) return;
    const slow = this.faults.get('slow_drain');
    const batch = this._take(slow ? SLOW_SPANS_PER_TICK : SPANS_PER_TICK);
    this._consume(batch);
    // Yield to the event loop so HTTP requests keep being served.
    this._schedule(slow ? SLOW_TICK_DELAY_MS : 0);
  }

  _consume(batch) {
    for (const span of batch) {
      try {
        this.consumer(span);
      } catch (err) {
        this.logger?.error?.('aggregator failed on span', span.trace_id, err);
      }
    }
    if (batch.length) this.drainRate.add(batch.length);
  }

  /** Synchronously hand every queued span to the consumer (tests, shutdown). */
  drainNow() {
    while (this.size > 0) this._consume(this._take(SPANS_PER_TICK));
  }
}

module.exports = { SpanQueue };
