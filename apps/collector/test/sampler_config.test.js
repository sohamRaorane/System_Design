'use strict';
// T8 sampler, T9 runtime config.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, fakeTrace } = require('./helpers');
const { RuntimeConfig } = require('../src/config/runtimeConfig');

// Hash from the id's numeric suffix: "x-5" -> 0.05, so decisions are exact.
const hash = (id) => Number(id.split('-')[1]) / 100;
const mkTrace = (id, o = {}) => {
  const t = fakeTrace(id, o);
  return Object.assign(t, { status: o.status ?? 'OK', duration_ms: o.duration ?? 100, is_complete: o.complete ?? true });
};

let h;
before(() => { h = harness({ hash, config: { normal_sampling_rate: 0.1 } }); });
after(() => h.cleanup());
const decide = (t) => h.ctx.sampler.decide(t);
const cfg = (p) => assert.ok(h.ctx.config.update(p).ok);

test('T8 rule order, each reason, ERROR beats slow (E32)', () => {
  assert.equal(decide(mkTrace('a-50', { status: 'ERROR', duration: 9999 })).reason, 'ERROR');
  assert.equal(decide(mkTrace('a-50', { duration: 9999 })).reason, 'HIGH_LATENCY');
  assert.equal(decide(mkTrace('a-50', { complete: false })).reason, 'INCOMPLETE');
  assert.equal(decide(mkTrace('a-05')).reason, 'NORMAL_SAMPLED');
  assert.equal(decide(mkTrace('a-50')).keep, false);
  assert.equal(h.ctx.metrics.c.dropped_total, 1);
});

test('T8 same id -> same decision (E38)', () => {
  const r = [1, 2, 3].map(() => decide(mkTrace('a-09')).keep);
  assert.deepEqual(r, [true, true, true]);
});

test('T8 normal rate 0 and 1 (E33, E34); incomplete can be turned off', () => {
  cfg({ normal_sampling_rate: 0 });
  assert.equal(decide(mkTrace('a-00')).keep, false);
  assert.equal(decide(mkTrace('a-00', { complete: false })).reason, 'INCOMPLETE');
  cfg({ keep_incomplete_traces: false });
  assert.equal(decide(mkTrace('a-00', { complete: false })).keep, false);
  cfg({ keep_incomplete_traces: true, normal_sampling_rate: 1 });
  assert.equal(decide(mkTrace('a-99')).keep, true);
  cfg({ normal_sampling_rate: 0.1 });
});

test('T8 error_sampling_rate < 1 falls through to later rules (E35)', () => {
  cfg({ error_sampling_rate: 0.5 });
  assert.equal(decide(mkTrace('e-10', { status: 'ERROR' })).reason, 'ERROR');
  assert.equal(decide(mkTrace('e-70', { status: 'ERROR' })).keep, false, 'dropped via normal rule');
  assert.equal(decide(mkTrace('e-70', { status: 'ERROR', duration: 9999 })).reason, 'HIGH_LATENCY', 'falls to latency rule');
  assert.equal(decide(mkTrace('e-08', { status: 'ERROR' })).reason, 'ERROR');
  cfg({ error_sampling_rate: 1 });
});

test('T8 backpressure scales the normal rate only (E36); threshold change is immediate (E37)', () => {
  const q = h.ctx.queue;
  Object.defineProperty(q, 'state', { get: () => 'SOFT', configurable: true });
  assert.equal(decide(mkTrace('b-02')).keep, true);
  assert.equal(decide(mkTrace('b-05')).keep, false);
  assert.equal(decide(mkTrace('b-05', { status: 'ERROR' })).reason, 'ERROR');
  assert.equal(decide(mkTrace('b-05', { duration: 5000 })).reason, 'HIGH_LATENCY');
  assert.ok(h.ctx.metrics.c.backpressure_adjusted_decisions >= 1);
  delete q.state;
  cfg({ latency_threshold_ms: 10000 });
  assert.equal(decide(mkTrace('b-50', { duration: 5000 })).keep, false);
});

test('T9 validation: every error reported, atomic reject, version unchanged (E53)', () => {
  const c = new RuntimeConfig();
  const v = c.version;
  const bad = [
    [{ normal_sampling_rate: 1.5 }, 'normal_sampling_rate'],
    [{ normal_sampling_rate: '0.5' }, 'normal_sampling_rate'],
    [{ queue_soft_limit: 20000 }, 'queue_soft_limit'],
    [{ nonsense: 1 }, 'nonsense'],
    [{ batch_flush_size: 1.5 }, 'batch_flush_size'],
    [{ settle_window_ms: 40000 }, 'settle_window_ms'],
    [{ cold_retention_days: 1 }, 'cold_retention_days'],
    [{ hot_retention_days: 0 }, 'hot_retention_days'],
    [{ keep_incomplete_traces: 'yes' }, 'keep_incomplete_traces'],
  ];
  for (const [patch, field] of bad) {
    const r = c.update(patch);
    assert.equal(r.ok, false, JSON.stringify(patch));
    assert.ok(r.errors.some((e) => e.field === field), field);
  }
  const multi = c.update({ normal_sampling_rate: 2, latency_threshold_ms: 0, error_sampling_rate: 0.5 });
  assert.equal(multi.errors.length, 2);
  assert.equal(c.get().error_sampling_rate, 1, 'nothing applied');
  assert.equal(c.version, v);
});

test('T9 valid update bumps version, accepts decimal retention, emits event, If-Match gives 409 (E54)', () => {
  const c = new RuntimeConfig();
  const events = [];
  c.on('config:changed', (e) => events.push(e.changed));
  assert.equal(c.update({ hot_retention_days: 0.001 }).version, 2);
  assert.equal(c.update({ normal_sampling_rate: 0.5 }).version, 3);
  assert.deepEqual(events, [['hot_retention_days'], ['normal_sampling_rate']]);
  assert.equal(c.update({ normal_sampling_rate: 0.6 }, { ifMatch: '2' }).status, 409);
  assert.equal(c.update({ normal_sampling_rate: 0.6 }, { ifMatch: '3' }).ok, true);
});

test('T9 PUT /v1/config over HTTP, admin token guard', async () => {
  const hh = harness({});
  hh.ctx.adminToken = '';
  const url = await hh.listen();
  try {
    let r = await fetch(url + '/v1/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"normal_sampling_rate":1.5}' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).errors[0].field, 'normal_sampling_rate');
    r = await fetch(url + '/v1/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"normal_sampling_rate":0.5}' });
    assert.equal((await r.json()).version, 2);
    const g = await (await fetch(url + '/v1/config')).json();
    assert.equal(g.config.normal_sampling_rate, 0.5);
  } finally { await hh.cleanup(); }
});

test('admin token required for PUT when configured', async () => {
  const { createApp } = require('../src/app');
  const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const { app, ctx } = createApp({ dbPath: path.join(dir, 'x.db'), coldDir: path.join(dir, 'c'), adminToken: 'tok' });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ normal_sampling_rate: 0.5 });
    const h0 = { 'content-type': 'application/json' };
    assert.equal((await fetch(url + '/v1/config', { method: 'PUT', headers: h0, body })).status, 401);
    assert.equal((await fetch(url + '/v1/config', { method: 'PUT', headers: { ...h0, 'X-Admin-Token': 'tok' }, body })).status, 200);
    assert.equal((await fetch(url + '/v1/config')).status, 200, 'reads are open');
  } finally { server.close(); await ctx.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); }
});
