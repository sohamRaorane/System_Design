'use strict';
// T3 out-of-order, T4 timeout, T5 settle, T6 dedup/late, T7 oddities.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { harness, span } = require('./helpers');

let h, agg, kept;
const hint = (n) => ({ 'trace.expected_spans': n });

async function setup(config = {}) {
  h = await harness({ config });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  agg = h.ctx.aggregator;
  kept = [];
  const add = h.ctx.batch.add.bind(h.ctx.batch);
  h.ctx.batch.add = (t) => { kept.push(t); add(t); };
}
beforeEach(() => setup());
afterEach(async () => { mock.timers.reset(); await h.cleanup(); });

test('T3 children before root wait; hint met finalizes immediately with sorted spans (E12, E13)', () => {
  agg.addSpan(span('t1', 'c2', 'r', { start: 1_800_000_000_020 }));
  agg.addSpan(span('t1', 'c1', 'r', { start: 1_800_000_000_010 }));
  assert.equal(kept.length, 0);
  assert.equal(agg.openCount, 1);
  agg.addSpan(span('t1', 'r', null, { start: 1_800_000_000_000, attrs: hint(3) }));
  assert.equal(kept.length, 1);
  const t = kept[0];
  assert.equal(h.ctx.metrics.c.traces_finalized.hint, 1);
  assert.equal(t.is_complete, true);
  assert.deepEqual(t.spans.map((s) => s.span_id), ['r', 'c1', 'c2']);
  assert.equal(t.root_service, 'svc');
  assert.equal(agg.openCount, 0);
});

test('T4 missing leaf with hint waits for timeout -> incomplete (E14)', () => {
  agg.addSpan(span('t2', 'r', null, { attrs: hint(3) }));
  agg.addSpan(span('t2', 'c1', 'r'));
  mock.timers.tick(29_999);
  assert.equal(kept.length, 0, 'settle window must not complete a hinted trace');
  mock.timers.tick(1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].is_complete, false);
  assert.equal(kept[0].sample_reason, 'INCOMPLETE');
  assert.equal(h.ctx.metrics.c.traces_finalized.timeout, 1);
});

test('T4 missing parent, no hint -> incomplete after timeout (E15)', () => {
  agg.addSpan(span('t3', 'r', null));
  agg.addSpan(span('t3', 'c', 'ghost'));
  mock.timers.tick(5_000);
  assert.equal(kept.length, 0);
  mock.timers.tick(25_000);
  assert.equal(kept[0].is_complete, false);
});

test('T4 no root ever -> incomplete, root_service from earliest span (E16)', () => {
  agg.addSpan(span('t4', 'b', 'a', { service: 'payment', start: 1_800_000_000_500 }));
  agg.addSpan(span('t4', 'c', 'a', { service: 'search', start: 1_800_000_000_100 }));
  mock.timers.tick(30_000);
  assert.equal(kept[0].is_complete, false);
  assert.equal(kept[0].root_service, 'search');
});

test('T5 no-hint trace finalizes settle_window after last span; timer re-arms (E15)', () => {
  agg.addSpan(span('t5', 'r', null));
  mock.timers.tick(400);
  agg.addSpan(span('t5', 'c', 'r')); // re-arms
  mock.timers.tick(499);
  assert.equal(kept.length, 0);
  mock.timers.tick(1);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].is_complete, true);
  assert.equal(h.ctx.metrics.c.traces_finalized.settle, 1);
});

test('T5 a span referencing a missing parent cancels the settle timer', () => {
  agg.addSpan(span('t5b', 'r', null));
  agg.addSpan(span('t5b', 'c', 'ghost'));
  mock.timers.tick(1_000);
  assert.equal(kept.length, 0);
});

test('T6 duplicates while open, conflicting body, tombstone duplicates and late spans (E26-E29)', () => {
  const m = h.ctx.metrics.c;
  agg.addSpan(span('t6', 'r', null, { attrs: hint(2), start: 1_800_000_000_000 }));
  agg.addSpan(span('t6', 'r', null, { attrs: hint(2), start: 1_800_000_000_000 })); // identical
  assert.equal(m.duplicate_spans, 1);
  assert.equal(m.conflicting_duplicates, 0);
  agg.addSpan(span('t6', 'r', null, { attrs: hint(2), start: 1_800_000_000_000, service: 'other' })); // conflicting
  assert.deepEqual([m.duplicate_spans, m.conflicting_duplicates], [2, 1]);
  agg.addSpan(span('t6', 'c', 'r')); // completes
  assert.equal(kept.length, 1);
  assert.equal(kept[0].spans.find((s) => s.span_id === 'r').service, 'svc', 'first copy kept');
  agg.addSpan(span('t6', 'c', 'r')); // tombstone duplicate (E28)
  assert.equal(m.duplicate_spans, 3);
  agg.addSpan(span('t6', 'late', 'r')); // late span (E29)
  assert.equal(m.late_spans, 1);
  assert.equal(agg.openCount, 0, 'late span never opens a new trace');
});

test('T6 full batch re-sent after a lost 202 changes nothing (E31)', () => {
  const batch = [span('t7', 'r', null, { attrs: hint(2) }), span('t7', 'c', 'r')];
  batch.forEach((s) => agg.addSpan(s));
  batch.forEach((s) => agg.addSpan(s));
  assert.equal(h.ctx.metrics.c.duplicate_spans, 2);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].span_count, 2);
});

test('T7 two roots: multi_root counted, earlier root used (E17)', () => {
  agg.addSpan(span('t8', 'r1', null, { service: 'first' }));
  agg.addSpan(span('t8', 'r2', null, { service: 'second' }));
  assert.equal(h.ctx.metrics.c.multi_root_traces, 1);
  mock.timers.tick(30_000);
  assert.equal(kept[0].root_service, 'first');
});

test('T7 parent cycle has no root -> incomplete (E18)', () => {
  agg.addSpan(span('t9', 'a', 'b'));
  agg.addSpan(span('t9', 'b', 'a'));
  mock.timers.tick(30_000);
  assert.equal(kept[0].is_complete, false);
});

test('T7 same span_id in two traces is independent (E20); zero-duration span valid (E21)', () => {
  agg.addSpan(span('ta', 'same', null, { attrs: hint(1), dur: 0 }));
  agg.addSpan(span('tb', 'same', null, { attrs: hint(1) }));
  assert.equal(kept.length, 2);
  assert.equal(h.ctx.metrics.c.duplicate_spans, 0);
  assert.equal(kept[0].duration_ms, 0);
});

test('T7 oversized trace is truncated and counted (E22)', async () => {
  mock.timers.reset(); await h.cleanup(); await setup({ max_spans_per_trace: 10 });
  agg.addSpan(span('big', 'r', null));
  for (let i = 0; i < 14; i++) agg.addSpan(span('big', 'c' + i, 'r'));
  assert.equal(h.ctx.metrics.c.oversized_spans_dropped, 5);
  mock.timers.tick(30_000);
  assert.equal(kept[0].span_count, 10);
  assert.equal(kept[0].truncated, true);
});

test('T7 open-trace explosion evicts the oldest as incomplete (E23)', async () => {
  mock.timers.reset(); await h.cleanup(); await setup({ max_open_traces: 100 });
  for (let i = 0; i < 150; i++) agg.addSpan(span('x' + i, 's', null, { attrs: hint(2) }));
  assert.equal(agg.openCount, 100);
  assert.equal(h.ctx.metrics.c.traces_finalized.evicted, 50);
  assert.ok(kept.every((t) => !t.is_complete));
});

test('T9 trace_timeout_ms change applies to new traces only (E25)', () => {
  agg.addSpan(span('old', 'r', null, { attrs: hint(2) })); // 30s deadline
  assert.ok(h.ctx.config.update({ trace_timeout_ms: 1_000 }).ok);
  agg.addSpan(span('new', 'r', null, { attrs: hint(2) }));
  mock.timers.tick(1_000);
  assert.deepEqual(kept.map((t) => t.trace_id), ['new']);
  mock.timers.tick(29_000);
  assert.deepEqual(kept.map((t) => t.trace_id), ['new', 'old']);
});

test('tombstones expire; sweep removes them', () => {
  agg.addSpan(span('tt', 'r', null, { attrs: hint(1) }));
  assert.equal(agg.tombstoneCount, 1);
  mock.timers.tick(61_000);
  agg.sweepTombstones();
  assert.equal(agg.tombstoneCount, 0);
});
