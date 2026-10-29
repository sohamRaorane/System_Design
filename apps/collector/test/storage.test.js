'use strict';
// T10 batching, T11 storage failure, T12 long outage, T13 merge-on-write.
const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { harness, fakeTrace, span, settle } = require('./helpers');

let h, batch, repo;
async function setup(config = {}) {
  h = await harness({ config });
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_800_000_000_000 });
  batch = h.ctx.batch; repo = h.ctx.repo;
  batch.start();
}
afterEach(async () => { mock.timers.reset(); await h.cleanup(); });
const count = () => repo.safeCount('hot');
/** Advance fake time, then let the async writer finish what the timers started. */
async function advance(ms) { mock.timers.tick(ms); await settle(); }
const getHot = (id) => repo.getHot('default', id);

test('T10 flush by size', async () => {
  await setup({ batch_flush_size: 3 });
  for (let i = 0; i < 2; i++) batch.add(fakeTrace('s' + i));
  await settle();
  assert.equal(await count(), 0);
  batch.add(fakeTrace('s2'));
  await settle();
  assert.equal(await count(), 3);
  assert.equal(h.ctx.metrics.c.batches_flushed, 1);
});

test('T10 flush by interval, nothing for an empty batch', async () => {
  await setup({ batch_flush_interval_ms: 5000 });
  batch.add(fakeTrace('i1'));
  await advance(4_999);
  assert.equal(await count(), 0);
  await advance(1);
  assert.equal(await count(), 1);
  await advance(5_000);
  assert.equal(h.ctx.metrics.c.batches_flushed, 1, 'empty interval flush writes nothing');
});

test('T10/E41 size and timer at once -> one flush, timer resets', async () => {
  await setup({ batch_flush_size: 2, batch_flush_interval_ms: 5000 });
  await advance(4_900);
  batch.add(fakeTrace('b1')); batch.add(fakeTrace('b2')); // size flush resets the timer
  batch.add(fakeTrace('b3'));
  await advance(200); // old timer would have fired here
  assert.equal(h.ctx.metrics.c.batches_flushed, 1);
  await advance(4_800);
  assert.equal(h.ctx.metrics.c.batches_flushed, 2);
});

test('T10/E40 batches are written strictly in order, never concurrently', async () => {
  await setup({ batch_flush_size: 1 });
  const order = [];
  const real = repo.insertBatch.bind(repo);
  let inFlight = 0;
  repo.insertBatch = async (ts) => {
    inFlight++;
    assert.equal(inFlight, 1);
    order.push(ts[0].trace_id);
    try { return await real(ts); } finally { inFlight--; }
  };
  for (const id of ['o1', 'o2', 'o3']) batch.add(fakeTrace(id));
  await settle(10);
  assert.deepEqual(order, ['o1', 'o2', 'o3']);
});

test('T10 stored_at is set and finalize-to-stored latency recorded', async () => {
  await setup({ batch_flush_size: 1 });
  const t = fakeTrace('lat');
  Object.defineProperty(t, '_finMono', { value: performance.now() - 50, writable: true });
  batch.add(t);
  await settle();
  assert.ok((await getHot('lat')).stored_at > 0);
  assert.ok(h.ctx.metrics.finalizeToStored.percentile(95) >= 50);
});

test('T11 retry with backoff, breaker closed->open->half_open->closed, no loss or duplicates (scenarios 3, 7)', async () => {
  await setup({ batch_flush_size: 1, retry_base_ms: 500, breaker_cooldown_ms: 10_000 });
  h.ctx.faults.update({ storage_down: true });
  batch.add(fakeTrace('x1', { reason: 'ERROR', status: 'ERROR' }));
  await settle();
  const m = h.ctx.metrics.c;
  assert.equal(m.batch_failures, 1);
  assert.equal(h.ctx.breaker.state, 'closed');
  await advance(700);   // retry 2
  await advance(1_400); // retry 3 -> opens
  assert.equal(m.batch_failures, 3);
  assert.equal(h.ctx.breaker.state, 'open');
  assert.equal(m.breaker_opened_total, 1);
  batch.add(fakeTrace('x2', { reason: 'ERROR', status: 'ERROR' }));
  await settle();
  assert.equal(batch.pendingCount, 2, 'ingestion continues, batches wait');

  await advance(9_000);
  assert.equal(h.ctx.breaker.state, 'open');
  await advance(2_000);
  // cooldown over: half_open trial runs while the fault is still on -> re-opens (E45)
  assert.equal(h.ctx.breaker.state, 'open');
  assert.equal(m.breaker_opened_total, 2);
  h.ctx.faults.update({ storage_down: false });
  await advance(11_000);
  assert.equal(h.ctx.breaker.state, 'closed');
  assert.equal(batch.pendingCount, 0);
  assert.equal(await count(), 2);
  assert.equal((await h.ctx.db.get('SELECT COUNT(*) AS n FROM trace_services')).n, 2, 'no duplicate index rows');
});

test('T11 mid-batch failure rolls the whole transaction back (E39); retry stores it whole', async () => {
  await setup({ batch_flush_size: 2 });
  const bad = fakeTrace('bad'); bad.sample_reason = null; // violates NOT NULL
  batch.add(fakeTrace('good')); batch.add(bad);
  await settle();
  assert.equal(await count(), 0, 'good trace rolled back with the bad one');
  assert.equal(batch.pendingCount, 1);
  batch.pending[0].traces[1].sample_reason = 'ERROR';
  await advance(1_000);
  assert.equal(await count(), 2);
});

test('T11/E43 any storage exception is treated as a failure (disk full / read-only)', async () => {
  await setup({ batch_flush_size: 1 });
  repo.insertBatch = async () => { throw new Error('SQLITE_FULL: database or disk is full'); };
  batch.add(fakeTrace('d1'));
  await settle();
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
    await settle(2);
  }
  const m = h.ctx.metrics.c;
  assert.ok(m.shed_during_outage > 0, 'normal traces shed');
  assert.ok(batch.pendingCount <= 2, 'memory bounded');
  const spillDir = batch.spillDir;
  for (let i = 0; i < 8; i++) { batch.add(fakeTrace('e2-' + i, { reason: 'ERROR' })); errors.push('e2-' + i); await settle(2); }
  assert.ok(m.spilled_batches > 0, 'spilled to disk');
  assert.ok(fs.readdirSync(spillDir).some((f) => f.endsWith('.jsonl')));

  h.ctx.faults.update({ storage_down: false });
  for (let i = 0; i < 30; i++) await advance(15_000);
  for (const id of errors) assert.ok(await getHot(id), `${id} stored after recovery`);
  assert.equal(fs.readdirSync(spillDir).filter((f) => f.endsWith('.jsonl')).length, 0, 'spill replayed and removed');
  assert.ok(m.replayed_spill_batches > 0);
});

test('T13 a late fragment never shrinks a stored trace; spans are unioned (E30, E46)', async () => {
  await setup();
  const full = [span('mw', 'r', null, { service: 'gateway', start: 1_000 })];
  for (let i = 0; i < 5; i++) full.push(span('mw', 'c' + i, 'r', { service: 'svc' + i, start: 1_001 + i }));
  await repo.insertBatch([fakeTrace('mw', { spans: full, reason: 'ERROR', status: 'ERROR' })]);
  assert.equal((await getHot('mw')).span_count, 6);

  const fragment = fakeTrace('mw', { spans: [span('mw', 'c0', 'r', { service: 'svc0', start: 1_001 })], reason: 'INCOMPLETE', complete: false });
  await repo.insertBatch([fragment]);
  const after = await getHot('mw');
  assert.equal(after.span_count, 6);
  assert.equal(after.sample_reason, 'ERROR', 'higher-priority reason kept');
  assert.equal(after.root_service, 'gateway');

  const extra = fakeTrace('mw', { spans: [span('mw', 'new', 'r', { service: 'extra', start: 1_100 })], reason: 'INCOMPLETE', complete: false });
  await repo.insertBatch([extra]);
  const merged = await getHot('mw');
  assert.equal(merged.span_count, 7);
  assert.ok(await h.ctx.db.get("SELECT 1 AS x FROM trace_services WHERE trace_id = 'mw' AND service = 'extra'"));
  assert.equal((await h.ctx.db.get('SELECT COUNT(*) AS n FROM traces')).n, 1);
});

test('same trace_id in two projects is stored separately', async () => {
  await setup();
  const a = fakeTrace('shared'); a.project_id = 'proj-a';
  const b = fakeTrace('shared', { reason: 'ERROR', status: 'ERROR' }); b.project_id = 'proj-b';
  await repo.insertBatch([a, b]);
  assert.equal((await repo.getHot('proj-a', 'shared')).sample_reason, 'NORMAL_SAMPLED');
  assert.equal((await repo.getHot('proj-b', 'shared')).sample_reason, 'ERROR');
  assert.equal(await repo.getHot('default', 'shared'), null);
  assert.equal(await repo.count('hot', 'proj-a'), 1);
});

test('findPending returns traces waiting in current batch or pending', async () => {
  await setup();
  batch.add(fakeTrace('p1'));
  assert.equal(batch.findPending('default', 'p1').trace_id, 'p1');
  assert.equal(batch.findPending('other', 'p1'), null);
  assert.equal(batch.findPending('default', 'nope'), null);
});
