'use strict';
// T17 graceful shutdown, T18 crash persistence, T20 load generator resilience.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { harness, span, wire, post, usingPostgres } = require('./helpers');
const { PostgresDb } = require('../src/db/postgres');
const { Sender } = require('../../../tools/loadgen/railway');

test('T17 shutdown finalizes open traces (cause=shutdown) and stores them before exit (E55)', async () => {
  const h = await harness();
  const { ctx } = h;
  // an open trace that is still waiting for spans, plus spans still sitting in the queue
  ctx.aggregator.addSpan(span('open1', 'r', null, { attrs: { 'trace.expected_spans': 5 } }));
  ctx.queue.push([span('queued1', 'r', null, { attrs: { 'trace.expected_spans': 1 } })]);
  ctx.batch.add(Object.assign(require('./helpers').fakeTrace('inbatch'), {}));
  const clean = await ctx.shutdown();
  assert.equal(clean, true);
  assert.equal(ctx.metrics.c.traces_finalized.shutdown, 1);
  let ids;
  if (usingPostgres) {
    const db = new PostgresDb(process.env.TEST_DATABASE_URL, { schema: ctx.env.pgSchema });
    ids = await db.all('SELECT trace_id, sample_reason, is_complete FROM traces ORDER BY trace_id');
    await db.dropSchema();
    await db.close();
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(h.dir, 'telemetry.db'), { readOnly: true });
    ids = db.prepare('SELECT trace_id, sample_reason, is_complete FROM traces ORDER BY trace_id').all();
    db.close();
  }
  assert.deepEqual(ids.map((r) => r.trace_id), ['inbatch', 'open1', 'queued1']);
  assert.equal(ids.find((r) => r.trace_id === 'open1').sample_reason, 'INCOMPLETE');
  fs.rmSync(h.dir, { recursive: true, force: true });
});

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() > end) throw new Error('timeout waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('T18 SIGKILL then restart: every stored trace survives (E56, scenario 1)', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-crash-'));
  const port = 4400 + Math.floor(Math.random() * 500);
  const cfgPath = path.join(dir, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ normal_sampling_rate: 1, batch_flush_interval_ms: 100 }));
  const schema = 't_' + crypto.randomBytes(6).toString('hex');
  const env = { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'd', 't.db'), COLD_DIR: path.join(dir, 'cold'), CONFIG_PATH: cfgPath, LOG_LEVEL: 'error',
    ...(usingPostgres ? { DATABASE_URL: process.env.TEST_DATABASE_URL, PG_SCHEMA: schema } : {}) };
  const url = `http://127.0.0.1:${port}`;
  const start = () => spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, stdio: 'ignore' });

  let child = start();
  try {
    await waitFor(async () => (await fetch(url + '/health')).ok);
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = 'crash' + String(i).padStart(2, '0');
      ids.push(id);
      const r = await post(url, wire({ trace_id: id, span_id: 'f'.repeat(16), status: 'ERROR', attributes: { 'trace.expected_spans': 1 } }));
      assert.equal(r.status, 202);
    }
    await waitFor(async () => (await (await fetch(url + '/metrics')).json()).storage.hot_trace_count === 20);
    const beforeCount = 20;
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));

    child = start();
    await waitFor(async () => (await fetch(url + '/health')).ok);
    const m = await (await fetch(url + '/metrics')).json();
    assert.ok(m.storage.hot_trace_count >= beforeCount);
    for (const id of ids) assert.equal((await fetch(url + '/v1/traces/' + id)).status, 200, id);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true });
    if (usingPostgres) { const db = new PostgresDb(process.env.TEST_DATABASE_URL, { schema }); await db.dropSchema(); await db.close(); }
  }
});

test('T20 load generator honours 429 Retry-After and drains after reconnect (E57, scenario 2)', { timeout: 60000 }, async () => {
  const received = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      if (calls === 1) { res.writeHead(429, { 'Retry-After': '1', 'content-type': 'application/json' }); return res.end('{}'); }
      const spans = JSON.parse(body).spans;
      received.push(...spans);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: spans.length, rejected: 0, errors: [] }));
    });
  });
  const port = 4950 + Math.floor(Math.random() * 40);
  const sender = new Sender(`http://127.0.0.1:${port}`);
  let done = false;
  const run = sender.run(() => done);
  for (let i = 0; i < 5; i++) sender.enqueue({ n: i });

  // collector is "down": the sender keeps retrying and holds the spans locally
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(sender.stats.network_retries >= 1);
  assert.equal(received.length, 0);
  const started = Date.now();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  await waitFor(() => received.length === 5, 30000);
  done = true;
  await run;
  server.close();
  assert.equal(sender.stats.throttled_429, 1);
  assert.deepEqual(received.map((s) => s.n).sort(), [0, 1, 2, 3, 4], 'no span lost, none duplicated');
  assert.ok(Date.now() - started >= 900, 'waited out Retry-After');
});
