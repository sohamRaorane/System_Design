'use strict';
// T10 batching, T11 storage failure, T12 long outage, T13 merge-on-write.
const { test, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, fakeTrace, span, tick } = require('./helpers');

let h, batch, repo;
async function setup(config = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  h = harness({ config });
  batch = h.ctx.batch; repo = h.ctx.repo;
  batch.start();
}
afterEach(async () => { mock.timers.reset(); await h.cleanup(); });
const count = () => repo.safeCount('hot');

test('T10 flush by size', async () => {
  await setup({ batch_flush_size: 3 });
  for (let i = 0; i < 2; i++) batch.add(fakeTrace('s' + i));
  assert.equal(count(), 0);
  batch.add(fakeTrace('s2'));
  assert.equal(count(), 3);
  assert.equal(h.ctx.metrics.c.batches_flushed, 1);
});

test('T10 flush by interval, nothing for an empty batch', async () => {
  await setup({ batch_flush_interval_ms: 5000 });
  batch.add(fakeTrace('i1'));
  mock.timers.tick(4_999);
  assert.equal(count(), 0);
  mock.timers.tick(1);
  assert.equal(count(), 1);
  mock.timers.tick(5_000);
  assert.equal(h.ctx.metrics.c.batches_flushed, 1, 'empty interval flush writes nothing');
});

test('T10/E41 size and timer at once -> one flush, timer resets', async () => {
  await setup({ batch_flush_size: 2, batch_flush_interval_ms: 5000 });
  mock.timers.tick(4_900);
  batch.add(fakeTrace('b1')); batch.add(fakeTrace('b2')); // size flush resets the timer
  batch.add(fakeTrace('b3'));
  mock.timers.tick(200); // old timer would have fired here
  assert.equal(h.ctx.metrics.c.batches_flushed, 1);
  mock.timers.tick(4_800);
  assert.equal(h.ctx.metrics.c.batches_flushed, 2);
});

test('T10/E40 batches are written strictly in order, never concurrently', async () => {
  await setup({ batch_flush_size: 1 });
  const order = [];
  const real = repo.insertBatch.bind(repo);
  let inFlight = 0;
  repo.insertBatch = (ts) => { inFlight++; assert.equal(inFlight, 1); order.push(ts[0].trace_id); const r = real(ts); inFlight--; return r; };
  for (const id of ['o1', 'o2', 'o3']) batch.add(fakeTrace(id));
  assert.deepEqual(order, ['o1', 'o2', 'o3']);
});

test('T10 stored_at is set and finalize-to-stored latency recorded', async () => {
  await setup({ batch_flush_size: 1 });
  const t = fakeTrace('lat');
  Object.defineProperty(t, '_finMono', { value: performance.now() - 50, writable: true });
  batch.add(t);
  assert.ok(repo.getHot('lat').stored_at > 0);
  assert.ok(h.ctx.metrics.finalizeToStored.percentile(95) >= 50);
});

test('T11 retry with backoff, breaker closed->open->half_open->closed, no loss or duplicates (scenarios 3, 7)', async () => {
  await setup({ batch_flush_size: 1, retry_base_ms: 500, breaker_cooldown_ms: 10_000 });
  h.ctx.faults.update({ storage_down: true });
  batch.add(fakeTrace('x1', { reason: 'ERROR', status: 'ERROR' }));
  const m = h.ctx.metrics.c;
  assert.equal(m.batch_failures, 1);
  assert.equal(h.ctx.breaker.state, 'closed');
  mock.timers.tick(700);  // retry 2
  mock.timers.tick(1_400); // retry 3 -> opens
  assert.equal(m.batch_failures, 3);
  assert.equal(h.ctx.breaker.state, 'open');
  assert.equal(m.breaker_opened_total, 1);
  batch.add(fakeTrace('x2', { reason: 'ERROR', status: 'ERROR' }));
  assert.equal(batch.pendingCount, 2, 'ingestion continues, batches wait');

  mock.timers.tick(9_000);
  assert.equal(h.ctx.breaker.state, 'open');
  mock.timers.tick(2_000);
  // cooldown over: half_open trial runs while the fault is still on -> re-opens (E45)
  assert.equal(h.ctx.breaker.state, 'open');
  assert.equal(m.breaker_opened_total, 2);
  h.ctx.faults.update({ storage_down: false });
  mock.timers.tick(11_000);
  assert.equal(h.ctx.breaker.state, 'closed');
  assert.equal(batch.pendingCount, 0);
  assert.equal(count(), 2);
  assert.equal(h.ctx.db.prepare('SELECT COUNT(*) n FROM trace_services').get().n, 2, 'no duplicate index rows');
});

test('T11 mid-batch failure rolls the whole transaction back (E39); retry stores it whole', async () => {
  await setup({ batch_flush_size: 2 });
  const bad = fakeTrace('bad'); bad.sample_reason = null; // violates NOT NULL
  batch.add(fakeTrace('good')); batch.add(bad);
  assert.equal(count(), 0, 'good trace rolled back with the bad one');
  assert.equal(batch.pendingCount, 1);
  batch.pending[0].traces[1].sample_reason = 'ERROR';
  mock.timers.tick(1_000);
  assert.equal(count(), 2);
});

test('T11/E43 any storage exception is treated as a failure (disk full / read-only)', async () => {
  await setup({ batch_flush_size: 1 });
  repo.insertBatch = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
  batch.add(fakeTrace('d1'));
  assert.equal(h.ctx.metrics.c.batch_failures, 1);
  assert.equal(batch.pendingCount, 1);
});

test('T12 long outage: normal traces shed first, then spill; priority traces all stored (E42)', async () => {
  await setup({ batch_flush_size: 2, max_pending_batches: 2 });
  h.ctx.faults.update({ storage_down: true });
  const errors = [];
  for (let i = 0; i < 10; i++) {
    const e = fakeTrace('err' + i, { reason: 'ERROR', status: 'ERROR' });
    errors.push(e.trace_id);
    batch.add(e);
    batch.add(fakeTrace('norm' + i));
  }
  const m = h.ctx.metrics.c;
  assert.ok(m.shed_during_outage > 0, 'normal traces shed');
  assert.ok(batch.pendingCount <= 2, 'memory bounded');
  const spillDir = batch.spillDir;
  // keep the all-ERROR spill case honest: add enough ERROR-only batches to force a spill
  for (let i = 0; i < 8; i++) { batch.add(fakeTrace('e2-' + i, { reason: 'ERROR' })); errors.push('e2-' + i); }
  assert.ok(m.spilled_batches > 0, 'spilled to disk');
  assert.ok(fs.readdirSync(spillDir).some((f) => f.endsWith('.jsonl')));

  h.ctx.faults.update({ storage_down: false });
  for (let i = 0; i < 30; i++) { mock.timers.tick(15_000); await tick(); }
  for (const id of errors) assert.ok(repo.getHot(id), `${id} stored after recovery`);
  assert.equal(fs.readdirSync(spillDir).filter((f) => f.endsWith('.jsonl')).length, 0, 'spill replayed and removed');
  assert.ok(m.replayed_spill_batches > 0);
});

test('T13 a late fragment never shrinks a stored trace; spans are unioned (E30, E46)', async () => {
  await setup();
  const full = [span('mw', 'r', null, { service: 'gateway', start: 1_000 })];
  for (let i = 0; i < 5; i++) full.push(span('mw', 'c' + i, 'r', { service: 'svc' + i, start: 1_001 + i }));
  repo.insertBatch([fakeTrace('mw', { spans: full, reason: 'ERROR', status: 'ERROR' })]);
  assert.equal(repo.getHot('mw').span_count, 6);

  const fragment = fakeTrace('mw', { spans: [span('mw', 'c0', 'r', { service: 'svc0', start: 1_001 })], reason: 'INCOMPLETE', complete: false });
  repo.insertBatch([fragment]);
  const after = repo.getHot('mw');
  assert.equal(after.span_count, 6);
  assert.equal(after.sample_reason, 'ERROR', 'higher-priority reason kept');
  assert.equal(after.root_service, 'gateway');

  const extra = fakeTrace('mw', { spans: [span('mw', 'new', 'r', { service: 'extra', start: 1_100 })], reason: 'INCOMPLETE', complete: false });
  repo.insertBatch([extra]);
  const merged = repo.getHot('mw');
  assert.equal(merged.span_count, 7);
  assert.ok(h.ctx.db.prepare("SELECT 1 FROM trace_services WHERE trace_id='mw' AND service='extra'").get());
  assert.equal(h.ctx.db.prepare('SELECT COUNT(*) n FROM traces').get().n, 1);
});

test('findPending returns traces waiting in current batch or pending', async () => {
  await setup();
  batch.add(fakeTrace('p1'));
  assert.equal(batch.findPending('p1').trace_id, 'p1');
  assert.equal(batch.findPending('nope'), null);
  void path;
});
