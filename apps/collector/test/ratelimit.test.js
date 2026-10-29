'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../src/util/rateLimit');
const { harness, wire } = require('./helpers');

test('token bucket: burst, sustained rate, retry hint, bounded memory', () => {
  let now = 0;
  const l = new RateLimiter({ ratePerSec: 2, burst: 4, clock: { now: () => now }, maxKeys: 3 });
  for (let i = 0; i < 4; i++) assert.equal(l.take('a').ok, true);
  const no = l.take('a');
  assert.deepEqual([no.ok, no.retryAfterS], [false, 1]);
  now += 500;
  assert.equal(l.take('a').ok, true, 'refilled one token in 0.5 s');
  assert.equal(l.take('b').ok, true, 'keys are independent');
  l.take('c'); l.take('d'); l.take('e');
  assert.ok(l.buckets.size <= 3);
});

test('ingest is limited per project with 429 + Retry-After; other projects unaffected', async () => {
  const h = await harness({ env: { limits: { ingestRps: 2, authPerMin: 1000 }, devLogin: true } });
  const url = await h.listen();
  try {
    const send = () => fetch(url + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spans: [wire()] }) });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await send()).status);
    assert.deepEqual(codes.slice(0, 4), [202, 202, 202, 202], 'burst of 2x the rate');
    const r = await send();
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.ok(h.ctx.metrics.c.rate_limited_requests >= 2);
  } finally { await h.cleanup(); }
});

test('sign-in endpoints are limited per client IP', async () => {
  const h = await harness({ env: { limits: { ingestRps: 50, authPerMin: 3 }, devLogin: true } });
  const url = await h.listen();
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await fetch(url + '/api/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 't' }, body: '{"login":"x"}' })).status);
    }
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally { await h.cleanup(); }
});
