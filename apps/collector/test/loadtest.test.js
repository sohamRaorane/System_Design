'use strict';
// Load testing: target safety (SSRF), ownership verification, a real run against a local
// server with trace correlation, limits, and simulated demo traffic.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { harness } = require('./helpers');
const { isPrivateAddress, parseTarget, vetHost, pinnedLookup, hostsFromSpan } = require('../src/loadtest/target');

test('private, loopback, link-local, CGNAT and mapped addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateAddress(ip), false, ip);
});

test('targets must be plain http(s) URLs; DNS answers are vetted and pinned', async () => {
  for (const bad of ['ftp://x.example', 'https://user:pw@x.example', 'not a url', 'file:///etc/passwd']) assert.throws(() => parseTarget(bad), bad);
  await assert.rejects(vetHost('evil.example', { lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }] }), (e) => e.code === 'private_address', 'any private answer is enough to refuse');
  await assert.rejects(vetHost('169.254.169.254'), (e) => e.code === 'private_address', 'cloud metadata IP');
  const answers = await vetHost('ok.example', { lookup: async () => [{ address: '93.184.216.34', family: 4 }] });
  pinnedLookup(answers)('anything-else.example', {}, (err, address) => assert.equal(address, '93.184.216.34'));
  pinnedLookup(answers)('x', { all: true }, (err, list) => assert.deepEqual(list, [{ address: '93.184.216.34', family: 4 }]));
});

test('hosts are read only from SERVER spans and standard attributes', () => {
  assert.deepEqual(hostsFromSpan({ kind: 'SERVER', attributes: { 'server.address': 'Shop.Example.com', 'url.full': 'https://api.example.com/x' } }).sort(), ['api.example.com', 'shop.example.com']);
  assert.deepEqual(hostsFromSpan({ kind: 'CLIENT', attributes: { 'server.address': 'victim.example' } }), [], 'a client span naming a host proves nothing');
});

// ---------------- HTTP flows ----------------
let h, url, token, pid, target, targetUrl;
const seen = [];

before(async () => {
  target = http.createServer((req, res) => {
    seen.push({ path: req.url, traceparent: req.headers.traceparent });
    if (req.url === '/.well-known/otel-pipeline.txt') { res.writeHead(200); return res.end(target.token || 'nothing'); }
    if (req.url.startsWith('/fail')) { res.writeHead(503); return res.end('down'); }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
  h = await harness({ start: true, config: { settle_window_ms: 150, batch_flush_interval_ms: 100, normal_sampling_rate: 1 }, env: { devLogin: true, loadtest: { allowPrivateTargets: true, maxRps: 50, maxDurationS: 120 } } });
  url = await h.listen();
  token = (await (await fetch(url + '/api/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 't' }, body: '{"login":"tester"}' })).json()).access_token;
  pid = (await api('/api/projects', { method: 'POST', body: { name: 'Load' } })).body.project.id;
});
after(async () => { await h.cleanup(); target.closeAllConnections(); await new Promise((r) => target.close(r)); });

async function api(path, { method = 'GET', body, tok = token } = {}) {
  const r = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function waitRun(id, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await api(`/api/projects/${pid}/loadtests/${id}`);
    if (r.body.run.status !== 'running') return r.body.run;
    if (Date.now() > end) throw new Error('run did not finish');
    await new Promise((res) => setTimeout(res, 200));
  }
}

test('ownership: token file proves it; without proof a public host is refused', async () => {
  const limits = await api(`/api/projects/${pid}/loadtests/limits`);
  target.token = limits.body.verify_token;
  const v = await api(`/api/projects/${pid}/loadtests/verify?url=${encodeURIComponent(targetUrl + '/')}`);
  assert.deepEqual([v.body.verified, v.body.method], [true, 'token_file']);
  target.token = null;

  // production-like: private targets refused, public hosts need proof
  h.ctx.env.loadtest.allowPrivateTargets = false;
  h.ctx.loadtests.lookup = async (host) => (host === 'inside.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '203.0.113.10', family: 4 }]);
  try {
    const priv = await api(`/api/projects/${pid}/loadtests/verify?url=${encodeURIComponent('https://inside.example/')}`);
    assert.equal(priv.status, 400);
    assert.equal(priv.body.error, 'private_address');
    h.ctx.loadtests._tokenFile = async () => false; // the public host does not serve the token
    const no = await api(`/api/projects/${pid}/loadtests/verify?url=${encodeURIComponent('https://shop.example/')}`);
    assert.equal(no.body.verified, false);
    const start = await api(`/api/projects/${pid}/loadtests`, { method: 'POST', body: { url: 'https://shop.example/', rps: 5, duration_s: 10 } });
    assert.equal(start.status, 403);
    // once the project's own server spans report that host, it is verified by telemetry
    h.ctx.loadtests.noteSpans(pid, [{ kind: 'SERVER', attributes: { 'server.address': 'shop.example' } }]);
    const yes = await api(`/api/projects/${pid}/loadtests/verify?url=${encodeURIComponent('https://shop.example/')}`);
    assert.deepEqual([yes.body.verified, yes.body.method], [true, 'telemetry']);
  } finally {
    h.ctx.env.loadtest.allowPrivateTargets = true;
    h.ctx.loadtests.lookup = undefined;
    delete h.ctx.loadtests._tokenFile;
  }
});

test('limits: rps and duration bounds', async () => {
  for (const body of [{ rps: 0, duration_s: 10 }, { rps: 51, duration_s: 10 }, { rps: 5, duration_s: 4 }, { rps: 5, duration_s: 121 }, { rps: 1.5, duration_s: 10 }]) {
    const r = await api(`/api/projects/${pid}/loadtests`, { method: 'POST', body: { url: targetUrl, ...body } });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('a run sends traceparent on every request, reports each second, and its traces are complete and listable', async () => {
  seen.length = 0;
  const r = await api(`/api/projects/${pid}/loadtests`, { method: 'POST', body: { url: targetUrl + '/fail', rps: 20, duration_s: 5 } });
  assert.equal(r.status, 201);
  assert.equal((await api(`/api/projects/${pid}/loadtests`, { method: 'POST', body: { url: targetUrl, rps: 5, duration_s: 5 } })).status, 409, 'one run at a time per project');
  const run = await waitRun(r.body.run.id);
  assert.equal(run.status, 'completed');
  assert.ok(run.summary.sent >= 90 && run.summary.sent <= 110, `sent ${run.summary.sent}`);
  assert.equal(run.summary.failed, run.summary.sent, '503s count as failures');
  assert.equal(run.summary.codes['503'], run.summary.sent);
  assert.equal(run.timeline.length, 5);
  const hits = seen.filter((s) => s.path === '/fail');
  assert.equal(hits.length, run.summary.sent);
  assert.ok(hits.every((s) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(s.traceparent)));

  // the client spans became ERROR traces in this project, findable by run
  let list;
  for (let i = 0; i < 40; i++) {
    list = await api(`/api/projects/${pid}/traces?loadtest=${run.id}&limit=200`);
    if (list.body.items.length >= run.summary.sent - 2) break;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.ok(list.body.items.length >= run.summary.sent - 2, `listed ${list.body.items.length}`);
  assert.ok(list.body.items.every((t) => t.root_service === 'tracepipe-loadtest' && t.status === 'ERROR' && t.is_complete));
  const one = await api(`/api/projects/${pid}/traces/${list.body.items[0].trace_id}`);
  assert.equal(one.body.trace.spans[0].attributes['http.response.status_code'], 503);
  const ids = new Set(hits.map((s) => s.traceparent.split('-')[1]));
  assert.ok(list.body.items.every((t) => ids.has(t.trace_id)), 'trace ids match the traceparent headers sent');
  const history = await api(`/api/projects/${pid}/loadtests`);
  assert.equal(history.body.runs[0].id, run.id);
});

test('stopping a run ends it early', async () => {
  const r = await api(`/api/projects/${pid}/loadtests`, { method: 'POST', body: { url: targetUrl, rps: 10, duration_s: 60 } });
  await new Promise((res) => setTimeout(res, 1200));
  assert.equal((await api(`/api/projects/${pid}/loadtests/${r.body.run.id}/stop`, { method: 'POST' })).status, 200);
  const run = await waitRun(r.body.run.id);
  assert.equal(run.status, 'stopped');
  assert.ok(run.summary.seconds < 10);
});

test('demo traffic fills a project with multi-service traces, including errors', async () => {
  const p2 = (await api('/api/projects', { method: 'POST', body: { name: 'Demo' } })).body.project.id;
  const r = await api(`/api/projects/${p2}/demo-traffic`, { method: 'POST', body: { rps: 20, duration_s: 5 } });
  assert.equal(r.status, 201);
  await new Promise((res) => setTimeout(res, 6500));
  const run = (await api(`/api/projects/${p2}/loadtests/${r.body.run.id}`)).body.run;
  assert.equal(run.status, 'completed');
  assert.ok(run.summary.sent >= 90);
  let stats;
  for (let i = 0; i < 20; i++) {
    stats = (await api(`/api/projects/${p2}/stats`)).body;
    if (stats.kept_24h.ERROR > 0 && stats.kept_24h.NORMAL_SAMPLED > 0) break;
    await new Promise((res) => setTimeout(res, 200));
  }
  assert.ok(stats.kept_24h.ERROR > 0 && stats.kept_24h.NORMAL_SAMPLED > 0, JSON.stringify(stats.kept_24h));
  const services = (await api(`/api/projects/${p2}/services`)).body.services;
  assert.ok(['gateway', 'payments', 'catalog'].every((s) => services.includes(s)) || ['gateway', 'catalog'].every((s) => services.includes(s)), services.join());
  assert.equal((await api(`/api/projects/${p2}`)).body.project.first_trace_at > 0, true, 'demo traffic counts as the first trace');
});
