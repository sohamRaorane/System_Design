'use strict';
// T1 span validation, T2 backpressure, T19 health.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, post, wire } = require('./helpers');

let h, url;
before(async () => { h = await harness(); url = await h.listen(); });
after(async () => { await h.cleanup(); await h2?.cleanup(); });

test('T1 malformed JSON -> 400 invalid_json, no stack (E1)', async () => {
  const r = await post(url, '{bad');
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.error, 'invalid_json');
  assert.ok(!JSON.stringify(b).includes('at '));
});

test('T1 empty body / empty spans -> 400 no_spans (E2)', async () => {
  for (const body of ['{"spans":[]}', '{}']) {
    const r = await post(url, body);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, 'no_spans');
  }
});

test('T1 wrong content type -> 415 (E11)', async () => {
  const r = await fetch(url + '/v1/traces', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
  assert.equal(r.status, 415);
});

test('T1 too many spans -> 413, oversize body -> 413 (E3)', async () => {
  const many = Array.from({ length: 1001 }, (_, i) => wire({ span_id: i.toString(16).padStart(16, '0') }));
  assert.equal((await post(url, { spans: many })).status, 413);
  const big = { spans: [wire({ attributes: { x: 'y'.repeat(4_300_000) } })] };
  assert.equal((await post(url, big)).status, 413);
});

test('T1 per-span rules (E5-E9, E19)', async () => {
  const bad = [
    wire({ end_time: 1, start_time: 5 }),                       // E5
    wire({ status: 'BOGUS' }),                                  // E6
    wire({ attributes: { a: { nested: 1 } } }),                 // E7 nested
    wire({ attributes: Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['k' + i, 1])) }), // E7 keys
    wire({ attributes: { big: 'z'.repeat(9000) } }),            // E7 size
    wire({ span_id: 'c'.repeat(16), parent_span_id: 'c'.repeat(16) }), // E19
    wire({ trace_id: 'has space' }),
    wire({ service: '' }),
    wire({ start_time: 1.5 }),
  ];
  const r = await post(url, { spans: bad });
  assert.equal(r.status, 400);
  const b = await r.json();
  assert.equal(b.accepted, 0);
  assert.equal(b.rejected, bad.length);
  assert.ok(new Set(b.errors.map((e) => e.index)).size === bad.length);
});

test('T1 partial batch -> 202 with errors[] (E4), upper-case ids lower-cased (E8), clock skew counted (E9)', async () => {
  const good = wire({ trace_id: 'ABCDEF'.padEnd(32, '0'), span_id: 'AA'.padEnd(16, '1') });
  const skew = wire({ trace_id: 'd'.repeat(32), span_id: 'e'.repeat(16), start_time: Date.now() + 3 * 3600_000, end_time: Date.now() + 3 * 3600_000 + 1 });
  const r = await post(url, { spans: [good, wire({ status: 'nope' }), skew] });
  assert.equal(r.status, 202);
  const b = await r.json();
  assert.deepEqual([b.accepted, b.rejected], [2, 1]);
  assert.equal(b.errors[0].index, 1);
  assert.equal(b.errors[0].field, 'status');
  assert.equal(h.ctx.metrics.c.clock_skew_spans, 1);
  const queued = h.ctx.queue.items.slice(h.ctx.queue.head);
  assert.equal(queued[0].trace_id, 'abcdef'.padEnd(32, '0'));
  assert.equal(queued[0].service, 'gateway');
  h.ctx.queue.drainNow();
});

let h2, url2;
test('T2 SOFT/FULL transitions, 429 + Retry-After, nothing queued on 429 (E10)', async () => {
  h2 = await harness({ config: { queue_soft_limit: 3, queue_hard_limit: 5 } });
  url2 = await h2.listen();
  const h = h2, url = url2;
  const q = h.ctx.queue;
  assert.equal(q.state, 'NORMAL');
  const mk = (n, base) => ({ spans: Array.from({ length: n }, (_, i) => wire({ trace_id: String(base) + 'a'.repeat(31), span_id: (base * 100 + i + 1).toString(16).padStart(16, '0') })) });
  assert.equal((await post(url, mk(3, 1))).status, 202);
  assert.equal(q.state, 'SOFT');
  const before = q.size;
  const r = await post(url, mk(3, 2));
  assert.equal(r.status, 429);
  const ra = Number(r.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 30);
  assert.equal(q.size, before, 'nothing queued');
  assert.equal(h.ctx.metrics.c.rejected_spans, 3);
  assert.equal((await post(url, mk(2, 3))).status, 202);
  assert.equal(q.state, 'FULL');
  assert.equal(q.highWatermark, 5);
});

test('T19 health: ok, then 503 when queue FULL, breaker open, or DB unreachable', async () => {
  const h = h2, url = url2;
  // queue is FULL from the previous test
  let r = await fetch(url + '/health');
  assert.equal(r.status, 503);
  assert.ok((await r.json()).reasons.some((x) => x.includes('queue')));
  h.ctx.queue.drainNow();
  r = await fetch(url + '/health');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');

  h.ctx.breaker.onFailure(); h.ctx.breaker.onFailure(); h.ctx.breaker.onFailure();
  r = await fetch(url + '/health');
  assert.equal(r.status, 503);
  assert.ok((await r.json()).reasons.some((x) => x.includes('breaker')));
  h.ctx.breaker.onSuccess();

  await h.ctx.db.close();
  r = await fetch(url + '/health');
  assert.equal(r.status, 503);
  assert.ok((await r.json()).reasons.some((x) => x.includes('database')));
});
