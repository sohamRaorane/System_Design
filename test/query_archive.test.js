'use strict';
// T14 query API, T15 archive happy path, T16 archive failures.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { harness, fakeTrace, span } = require('./helpers');

const DAY = 86400000;
let h, url;
before(async () => { h = harness(); url = await h.listen(); });
after(() => h.cleanup());
const get = async (p) => { const r = await fetch(url + p); return { status: r.status, body: await r.json() }; };

test('T14 filters, service join, keyset paging, limit cap, bad params', async () => {
  const base = Date.now() - 1000;
  const traces = [];
  for (let i = 0; i < 30; i++) {
    const err = i % 3 === 0, slow = i % 5 === 0;
    const spans = [
      span('q' + i, 'r', null, { service: 'gateway', start: base, dur: slow ? 3000 : 100, status: err ? 'ERROR' : 'OK' }),
      span('q' + i, 'p', 'r', { service: i % 2 ? 'payment' : 'search', start: base + 1 }),
    ];
    traces.push(fakeTrace('q' + String(i).padStart(2, '0'), { spans, reason: err ? 'ERROR' : slow ? 'HIGH_LATENCY' : 'NORMAL_SAMPLED', status: err ? 'ERROR' : 'OK', finalized: base + i }));
  }
  h.ctx.repo.insertBatch(traces);

  assert.equal((await get('/v1/traces?status=ERROR&limit=200')).body.items.length, 10);
  const pay = (await get('/v1/traces?service=payment&limit=200')).body.items;
  assert.equal(pay.length, 15);
  const slowPay = (await get('/v1/traces?service=PAYMENT&min_duration_ms=2000&limit=200')).body.items;
  assert.ok(slowPay.length > 0 && slowPay.every((t) => t.duration_ms >= 2000));
  assert.equal((await get('/v1/traces?reason=HIGH_LATENCY&limit=200')).body.items.every((t) => t.sample_reason === 'HIGH_LATENCY'), true);
  assert.ok(!('spans_json' in (await get('/v1/traces?limit=1')).body.items[0]), 'summaries only');

  // keyset paging: no gaps/dupes, newest first
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const { body } = await get('/v1/traces?limit=7' + (cursor ? '&cursor=' + cursor : ''));
    seen.push(...body.items.map((t) => t.trace_id));
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  assert.equal(seen.length, 30);
  assert.equal(new Set(seen).size, 30);
  assert.equal(seen[0], 'q29');

  // E52 cap, E51 bad params
  assert.equal((await get('/v1/traces?limit=100000')).body.items.length, 30);
  for (const bad of ['limit=abc', 'min_duration_ms=-1', "service='; DROP TABLE traces;--&status=NOPE", 'cursor=%%%', 'cursor=' + Buffer.from('x:y;z').toString('base64url'), 'from=1.5', 'status=ERROR%27%20OR%201=1']) {
    assert.equal((await get('/v1/traces?' + bad)).status, 400, bad);
  }
  assert.equal(h.ctx.repo.safeCount('hot'), 30, 'table intact');
});

test('T14 GET by id: hot / in_flight / pending / 404 / 400', async () => {
  const { aggregator, batch } = h.ctx;
  assert.equal((await get('/v1/traces/q05')).body.source, 'hot');
  aggregator.addSpan(span('inflight', 'r', null, { attrs: { 'trace.expected_spans': 3 } }));
  const inflight = await get('/v1/traces/inflight');
  assert.equal(inflight.body.source, 'in_flight');
  assert.equal(inflight.body.partial, true);
  batch.add(fakeTrace('pend1'));
  assert.equal((await get('/v1/traces/pend1')).body.source, 'pending');
  assert.equal((await get('/v1/traces/missing')).status, 404);
  assert.equal((await get('/v1/traces/' + encodeURIComponent('bad id!'))).status, 400);
  aggregator.finalizeAll();
  batch.drainAll();
});

async function archiveSetup(ids) {
  const old = Date.now() - 3 * DAY;
  h.ctx.config.update({ hot_retention_days: 1 });
  h.ctx.repo.insertBatch(ids.map((id, i) => fakeTrace(id, { finalized: old + i, reason: 'ERROR', status: 'ERROR' })));
}

test('T15 aged traces are archived, indexed, removed from hot, readable as cold (scenario 8)', async () => {
  await archiveSetup(['arc1', 'arc2']);
  const res = await h.ctx.archiver.runOnce();
  assert.deepEqual([res.ok, res.archived], [true, 2]);
  assert.equal(h.ctx.repo.getHot('arc1'), null);
  const entry = h.ctx.repo.getArchiveEntry('arc1');
  assert.match(entry.file_path.replace(/\\/g, '/'), /cold\/\d{4}-\d{2}-\d{2}\/batch-.*\.json\.gz$/);
  assert.ok(fs.existsSync(entry.file_path));
  const r = await get('/v1/traces/arc1');
  assert.equal(r.body.source, 'cold');
  assert.equal(r.body.trace.trace_id, 'arc1');
  assert.equal(h.ctx.metrics.c.archived_traces, 2);
  const withArchive = await get('/v1/traces?status=ERROR&include_archived=true&limit=200');
  assert.ok(withArchive.body.archived.some((t) => t.trace_id === 'arc2'));
  assert.equal(fs.readdirSync(path.dirname(entry.file_path)).filter((f) => f.endsWith('.tmp')).length, 0);
});

test('T16 archive_down leaves hot rows; later run archives them (scenario 8)', async () => {
  await archiveSetup(['fail1']);
  h.ctx.faults.update({ archive_down: true });
  const res = await h.ctx.archiver.runOnce();
  assert.equal(res.ok, false);
  assert.equal(h.ctx.metrics.c.archive_failures, 1);
  assert.equal(h.ctx.metrics.c.archive_retries, 1);
  assert.ok(h.ctx.repo.getHot('fail1'), 'hot row untouched');
  assert.equal((await get('/v1/traces/fail1')).body.source, 'hot');
  h.ctx.faults.update({ archive_down: false });
  assert.equal((await h.ctx.archiver.runOnce()).archived, 1);
  assert.equal((await get('/v1/traces/fail1')).body.source, 'cold');
});

test('T16 crash after rename, before hot delete: next run rewrites; index points at newer file (E47)', async () => {
  await archiveSetup(['crash1']);
  const { archiver } = h.ctx;
  const realDelete = archiver.deleteHot;
  archiver.deleteHot = { run() { throw new Error('simulated crash'); } };
  assert.equal((await archiver.runOnce()).ok, false);
  archiver.deleteHot = realDelete;
  assert.ok(h.ctx.repo.getHot('crash1'), 'still hot');
  assert.equal(h.ctx.repo.getArchiveEntry('crash1'), null, 'index transaction rolled back');
  assert.equal((await archiver.runOnce()).archived, 1);
  const entry = h.ctx.repo.getArchiveEntry('crash1');
  const dayDir = path.dirname(entry.file_path);
  assert.equal(fs.readdirSync(dayDir).filter((f) => f.startsWith('batch-')).length >= 2, true, 'harmless older duplicate');
  assert.equal((await get('/v1/traces/crash1')).body.source, 'cold');
});

test('T16 leftover .tmp files deleted at startup (E48)', () => {
  const dir = path.join(h.dir, 'cold', '2020-01-01');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.batch-1.json.gz.tmp'), 'junk');
  h.ctx.archiver.cleanTmp();
  assert.equal(fs.existsSync(path.join(dir, '.batch-1.json.gz.tmp')), false);
});

test('T16 corrupt or missing cold file -> 404 archive_error, server keeps running (E49)', async () => {
  await archiveSetup(['corrupt1', 'missing1']);
  const { archiver, repo, coldReader } = h.ctx;
  // archive each in its own run so they land in separate files
  h.ctx.db.prepare("UPDATE traces SET finalized_at = finalized_at - 5*86400000 WHERE trace_id='missing1'").run();
  await archiver.runOnce();
  const file = repo.getArchiveEntry('corrupt1').file_path;
  coldReader.cache.clear();
  fs.writeFileSync(file, 'not gzip at all');
  const r = await get('/v1/traces/corrupt1');
  assert.equal(r.status, 404);
  assert.match(r.body.archive_error, /archive_error/);
  assert.ok(h.ctx.metrics.c.cold_read_errors >= 1);
  fs.rmSync(repo.getArchiveEntry('missing1').file_path, { force: true });
  coldReader.cache.clear();
  assert.equal((await get('/v1/traces/missing1')).status, 404);
  assert.equal((await fetch(url + '/health')).status, 200);
});

test('E50 backlog drains at archive_batch_size per run', async () => {
  const old = Date.now() - 10 * DAY;
  h.ctx.config.update({ hot_retention_days: 1, archive_batch_size: 3 });
  h.ctx.repo.insertBatch(Array.from({ length: 7 }, (_, i) => fakeTrace('bl' + i, { finalized: old + i })));
  assert.equal((await h.ctx.archiver.runOnce()).archived, 3);
  assert.equal((await h.ctx.archiver.runOnce()).archived, 3);
  assert.equal((await h.ctx.archiver.runOnce()).archived, 1);
});
