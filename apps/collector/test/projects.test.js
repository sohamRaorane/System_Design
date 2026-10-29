'use strict';
// Projects, ingest keys and tenant isolation.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, fakeTrace, wire } = require('./helpers');

let h, url, alice, bob, admin;
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

async function login(name) {
  const r = await fetch(url + '/api/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 't' }, body: JSON.stringify({ login: name }) });
  return (await r.json()).access_token;
}
const api = async (token, path, { method = 'GET', body } = {}) => {
  const r = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + token, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const otlp = (traceId, { service = 'web', error = false } = {}) => {
  const t = Date.now();
  return { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans: [
    { traceId, spanId: 'a'.repeat(16), name: 'GET /', kind: 2, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + 20), status: { code: error ? 2 : 0 }, attributes: [{ key: 'trace.expected_spans', value: { intValue: 1 } }] },
  ] }] }] };
};
const send = (body, headers = {}) => fetch(url + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); }
}

before(async () => {
  h = await harness({ start: true, config: { batch_flush_interval_ms: 100, settle_window_ms: 100 }, env: { devLogin: true, adminLogins: ['root'] } });
  url = await h.listen();
  [alice, bob, admin] = await Promise.all([login('alice'), login('bob'), login('root')]);
});
after(() => h.cleanup());

let projectId, key;
test('create a project: returns the ingest key once and the setup values', async () => {
  const r = await api(alice, '/api/projects', { method: 'POST', body: { name: 'Checkout service' } });
  assert.equal(r.status, 201);
  projectId = r.body.project.id;
  key = r.body.key.value;
  assert.match(key, /^otk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{20,}$/);
  assert.equal(r.body.setup.header_name, 'x-api-key');
  assert.ok(r.body.setup.env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const keys = await api(alice, `/api/projects/${projectId}/keys`);
  assert.equal(keys.body.keys.length, 1);
  assert.ok(!('hash' in keys.body.keys[0]) && !('value' in keys.body.keys[0]), 'secret never listed again');
  assert.equal((await api(alice, '/api/projects', { method: 'POST', body: { name: '' } })).status, 400);
});

test('projects are private: other users get 404 for everything under them', async () => {
  for (const p of ['', '/keys', '/traces', '/stats', '/services']) assert.equal((await api(bob, `/api/projects/${projectId}${p}`)).status, 404, p);
  assert.equal((await api(bob, `/api/projects/${projectId}`, { method: 'DELETE' })).status, 404);
  assert.equal((await api(bob, '/api/projects')).body.projects.length, 0);
  assert.equal((await api(alice, '/api/projects/default')).status, 404, 'default project is for admins');
  assert.ok((await api(admin, '/api/projects')).body.projects.some((p) => p.id === 'default'));
  assert.equal((await fetch(url + '/api/projects')).status, 401);
});

test('ingest with a key lands in that project only; first trace is recorded', async () => {
  assert.equal((await api(alice, `/api/projects/${projectId}`)).body.project.first_trace_at, null);
  const traceId = '1'.repeat(32);
  assert.equal((await send(otlp(traceId, { error: true }), { 'x-api-key': key })).status, 200);
  const found = await waitFor(async () => { const r = await api(alice, `/api/projects/${projectId}/traces/${traceId}`); return r.status === 200 && r.body.source === 'hot' ? r : null; });
  assert.equal(found.body.trace.project_id, projectId);
  assert.equal((await api(admin, `/api/projects/default/traces/${traceId}`)).status, 404, 'not in the default project');
  const list = await api(alice, `/api/projects/${projectId}/traces`);
  assert.deepEqual(list.body.items.map((t) => t.trace_id), [traceId]);
  const p = await waitFor(async () => { const r = await api(alice, `/api/projects/${projectId}`); return r.body.project.first_trace_at ? r : null; });
  assert.ok(p.body.live.spans_since_start >= 1);
  const stats = await api(alice, `/api/projects/${projectId}/stats`);
  assert.equal(stats.body.kept_24h.ERROR, 1);
  assert.deepEqual((await api(alice, `/api/projects/${projectId}/services`)).body.services, ['web']);
});

test('key formats: x-api-key and Bearer both work; bad keys get 401 with a reason', async () => {
  assert.equal((await send(otlp('2'.repeat(32)), { authorization: 'Bearer ' + key })).status, 200);
  const bad = await send(otlp('3'.repeat(32)), { 'x-api-key': key.slice(0, -2) + 'xx' });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error, 'invalid_api_key');
  assert.equal((await send(otlp('3'.repeat(32)), { 'x-api-key': 'nonsense' })).status, 401);
});

test('anonymous spans go to "default" in development, and are refused when not allowed', async () => {
  assert.equal((await send(otlp('4'.repeat(32)))).status, 200);
  await waitFor(async () => (await api(admin, `/api/projects/default/traces/${'4'.repeat(32)}`)).status === 200);
  h.ctx.env.allowAnonymousIngest = false;
  try {
    const r = await send(otlp('5'.repeat(32)));
    assert.equal(r.status, 401);
    assert.match((await r.json()).message, /x-api-key/);
    const legacy = await fetch(url + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spans: [wire()] }) });
    assert.equal(legacy.status, 401);
  } finally { h.ctx.env.allowAnonymousIngest = true; }
});

test('per-project sampling: rate 0 here drops healthy traces, while errors are still kept', async () => {
  const bad = await api(alice, `/api/projects/${projectId}`, { method: 'PATCH', body: { settings: { normal_sampling_rate: 2 } } });
  assert.equal(bad.status, 400);
  const ok = await api(alice, `/api/projects/${projectId}`, { method: 'PATCH', body: { settings: { normal_sampling_rate: 0 } } });
  assert.equal(ok.body.project.settings.normal_sampling_rate, 0);
  const healthy = '6'.repeat(32);
  const failing = '7'.repeat(32);
  await send(otlp(healthy), { 'x-api-key': key });
  await send(otlp(failing, { error: true }), { 'x-api-key': key });
  await waitFor(async () => (await api(alice, `/api/projects/${projectId}/traces/${failing}`)).body?.source === 'hot');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await api(alice, `/api/projects/${projectId}/traces/${healthy}`)).status, 404, 'healthy trace sampled out');
  // the global rate (1 in this harness) still applies to other projects
  await send(otlp(healthy));
  await waitFor(async () => (await api(admin, `/api/projects/default/traces/${healthy}`)).status === 200);
  const reset = await api(alice, `/api/projects/${projectId}`, { method: 'PATCH', body: { settings: { normal_sampling_rate: null } } });
  assert.deepEqual(reset.body.project.settings, {}, 'null returns to the global default');
});

test('per-project hot retention archives only that project early', async () => {
  const old = Date.now() - 2 * 86400000;
  const mine = fakeTrace('retain-mine', { finalized: old }); mine.project_id = projectId;
  const other = fakeTrace('retain-default', { finalized: old });
  await h.ctx.repo.insertBatch([mine, other]);
  await api(alice, `/api/projects/${projectId}`, { method: 'PATCH', body: { settings: { hot_retention_days: 1 } } });
  const r = await h.ctx.archiver.runOnce(); // global retention is 7 days
  assert.equal(r.archived, 1);
  assert.equal(await h.ctx.repo.getHot(projectId, 'retain-mine'), null);
  assert.ok(await h.ctx.repo.getHot('default', 'retain-default'));
  assert.equal((await api(alice, `/api/projects/${projectId}/traces/retain-mine`)).body.source, 'cold');
});

test('revoking a key stops ingest immediately; deleting a project removes its data', async () => {
  const k2 = (await api(alice, `/api/projects/${projectId}/keys`, { method: 'POST', body: { label: 'ci' } })).body.key;
  assert.equal((await send(otlp('8'.repeat(32)), { 'x-api-key': k2.value })).status, 200);
  assert.equal((await api(alice, `/api/projects/${projectId}/keys/${k2.id}`, { method: 'DELETE' })).status, 200);
  const r = await send(otlp('9'.repeat(32)), { 'x-api-key': k2.value });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).error, 'revoked_api_key');

  assert.equal((await api(alice, '/api/projects/default', { method: 'DELETE' })).status, 404);
  assert.equal((await api(alice, `/api/projects/${projectId}`, { method: 'DELETE' })).status, 200);
  assert.equal(await h.ctx.repo.count('hot', projectId), 0);
  assert.equal((await send(otlp('a'.repeat(32)), { 'x-api-key': key })).status, 401, 'keys of a deleted project stop working');
});
