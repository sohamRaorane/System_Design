'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');
const { buildTrace } = require('../src/aggregate/traceBuilder');

/** Isolated pipeline: temp db + cold dir. The pipeline is NOT started (no timers) unless start:true. */
/** Postgres for the whole suite when TEST_DATABASE_URL is set (CI); each harness gets its own schema. */
const PG_URL = process.env.TEST_DATABASE_URL || '';
const usingPostgres = Boolean(PG_URL);

async function harness({ config = {}, hash, start = false, clock, env = {}, ...extra } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-'));
  const pg = usingPostgres ? { databaseUrl: PG_URL, env: { ...env, pgSchema: 't_' + crypto.randomBytes(6).toString('hex') } } : { env };
  const { app, ctx } = await createApp({
    config: { normal_sampling_rate: 1, ...config },
    dbPath: path.join(dir, 'telemetry.db'),
    coldDir: path.join(dir, 'cold'),
    spillDir: path.join(dir, 'spill'),
    hash,
    clock,
    ...extra,
    ...pg,
  });
  if (start) ctx.start();
  let server = null;
  return {
    app, ctx, dir,
    async listen() {
      await new Promise((r) => { server = app.listen(0, r); });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async cleanup() {
      if (server) { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); }
      try { await ctx.shutdown(); } catch { /* already closed */ }
      if (usingPostgres) {
        const { PostgresDb } = require('../src/db/postgres');
        const admin = new PostgresDb(PG_URL, { schema: ctx.env.pgSchema });
        try { await admin.dropSchema(); } finally { await admin.close(); }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let seq = 0;
/** A normalised span (as the validator would produce it). */
function span(traceId, spanId, parent, o = {}) {
  const start = o.start ?? 1_800_000_000_000 + (seq++ % 1000);
  return {
    trace_id: traceId, span_id: spanId, parent_span_id: parent ?? null,
    service: o.service ?? 'svc', operation: o.operation ?? 'op',
    start_time: start, end_time: o.end ?? start + (o.dur ?? 10),
    status: o.status ?? 'OK', attributes: o.attrs ?? {},
  };
}

/** A finished Trace record ready for repo.insertBatch. */
function fakeTrace(id, { reason = 'NORMAL_SAMPLED', status = 'OK', spans, finalized = Date.now(), complete = true } = {}) {
  const sp = spans ?? [span(id, id + '-r', null, { status, service: 'gateway' })];
  const t = buildTrace(sp, { trace_id: id, is_complete: complete, created_at: finalized - 10, finalized_at: finalized });
  return Object.assign(t, { sampled: true, sample_reason: reason });
}

const post = (url, body, headers = {}) =>
  fetch(url + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Wire-format span with sane defaults (for HTTP tests). */
function wire(o = {}) {
  const now = Date.now();
  return { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16), parent_span_id: null, service: 'Gateway', operation: 'op', start_time: now, end_time: now + 5, status: 'OK', ...o };
}

const tick = () => new Promise((r) => setImmediate(r));
/** Let pending async storage work (several promise hops) run to completion. */
async function settle(n = 5) {
  for (let i = 0; i < n; i++) await tick();
}

module.exports = { harness, span, fakeTrace, post, wire, tick, settle, usingPostgres };
