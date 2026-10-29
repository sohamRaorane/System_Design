'use strict';
// End-to-end: the real dashboard (built) + the real collector + a fake GitHub, driven in
// Chromium. Covers the product's main journeys.
//   npm run build:web && npm run e2e
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { createApp } = require('../apps/collector/src/app');
const { fakeGitHub } = require('../apps/collector/test/fakeGithub');

const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'apps', 'web', 'dist');
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

let gh, ctx, server, base, browser, page, target, targetUrl, dir;
const pageErrors = [];

before(async () => {
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))) throw new Error(`build the dashboard first (npm run build:web); no index.html in ${WEB_DIST}`);
  gh = fakeGitHub({ repos: { 'octo-dev/shop': { default_branch: 'main', files: { 'package.json': '{\n  "name": "shop",\n  "scripts": { "start": "node index.js" }\n}\n' } } } });
  const ghUrl = await gh.start();
  target = http.createServer((req, res) => { res.writeHead(req.url.startsWith('/fail') ? 500 : 200); res.end('ok'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${target.address().port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  // the dashboard is served by the collector itself, so everything is one origin
  const port = 4600 + Math.floor(Math.random() * 300);
  base = `http://localhost:${port}`;
  const appKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  ({ ctx, app: server } = await createApp({
    dbPath: path.join(dir, 't.db'), coldDir: path.join(dir, 'cold'), webDist: WEB_DIST,
    config: { settle_window_ms: 300, batch_flush_interval_ms: 200 },
    env: {
      devLogin: true, webOrigin: base, publicUrl: base, githubEnabled: true, githubAppEnabled: true,
      github: { clientId: 'cid', clientSecret: 'sec', appId: '1', appSlug: 'tracepipe-e2e', appPrivateKey: appKey, apiUrl: ghUrl, webUrl: ghUrl },
      loadtest: { allowPrivateTargets: true, maxRps: 50, maxDurationS: 120 },
    },
  }).then(({ app, ctx: c }) => ({ ctx: c, app: app.listen(port) })));
  ctx.start();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await ctx.shutdown();
  await gh.close();
  target.closeAllConnections?.();
  await new Promise((r) => target.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

let projectId;
let key;

test('signed-out visitors land on sign-in and come back where they wanted to go', async () => {
  await page.goto(base + '/projects', { waitUntil: 'networkidle' });
  assert.match(page.url(), /\/login\?next=%2Fprojects$/);
  await page.getByRole('link', { name: 'Sign in with GitHub' }).click();
  await page.waitForURL(base + '/projects');
  await page.getByText('octo-dev').first().waitFor();
});

test('create a project, connect a repository, open the pull request, receive the first trace', async () => {
  await page.getByLabel('Project name').fill('Shop');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByText('Shop is ready').waitFor();
  await page.getByRole('button', { name: 'Choose a repository' }).click();
  projectId = new URL(page.url()).pathname.split('/')[2];
  await page.getByRole('listitem').filter({ hasText: 'octo-dev/shop' }).getByRole('button', { name: 'Use this repository' }).click();
  await page.getByText('package.json').first().waitFor();
  await page.getByRole('button', { name: 'Open pull request' }).click();
  await page.getByText('Pull request opened').waitFor();
  assert.equal(gh.state.pulls.length, 1);
  await page.getByRole('button', { name: 'Create an ingest key for this app' }).click();
  key = (await page.locator('.notice.ok code').innerText()).trim();
  assert.match(key, /^otk_/);
  await page.getByText('Waiting for the first trace').waitFor();

  const t = Date.now();
  const tid = 'e2e'.padEnd(32, '0').replace(/[^0-9a-f]/g, 'e');
  const svc = (name, spans) => ({ resource: { attributes: [{ key: 'service.name', value: { stringValue: name } }] }, scopeSpans: [{ spans }] });
  const body = { resourceSpans: [
    svc('web', [{ traceId: tid, spanId: 'a'.repeat(16), name: 'POST /checkout', kind: 2, startTimeUnixNano: ns(t), endTimeUnixNano: ns(t + 90), status: { code: 2 } }]),
    svc('payments', [{ traceId: tid, spanId: 'b'.repeat(16), parentSpanId: 'a'.repeat(16), name: 'charge card', kind: 2, startTimeUnixNano: ns(t + 10), endTimeUnixNano: ns(t + 80), status: { code: 2, message: 'declined' },
      events: [{ name: 'exception', timeUnixNano: ns(t + 70), attributes: [{ key: 'exception.message', value: { stringValue: 'card declined by issuer' } }] }] }]),
  ] };
  const r = await fetch(base + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  await page.getByText('Receiving traces').waitFor({ timeout: 10000 });
});

test('the failed request shows up as needing attention and its waterfall shows the exception', async () => {
  await page.getByRole('button', { name: 'Open the overview' }).click();
  await page.getByRole('heading', { name: 'Traces that need attention' }).waitFor();
  await page.locator('.tlist').getByText('POST /checkout').first().click({ timeout: 15000 });
  await page.waitForURL(/\/traces\/[0-9a-f]{32}/);
  await page.getByRole('button', { name: /charge card/ }).click();
  await page.getByText('card declined by issuer').waitFor();
  await page.getByText('Failed').first().waitFor();
});

test('load test: check access, run, see the run\'s traces', async () => {
  await page.getByRole('link', { name: 'Load test' }).click();
  await page.getByLabel('Address to test').fill(targetUrl + '/fail');
  await page.getByRole('button', { name: 'Check access' }).click();
  await page.getByText('You can test').waitFor();
  await page.getByLabel('For').first().selectOption('15');
  await page.getByRole('button', { name: /^Start:/ }).click();
  await page.getByText(/Finished/).waitFor({ timeout: 40000 });
  await page.getByRole('button', { name: 'See the traces from this run' }).click();
  await page.getByText(/Only test run/).waitFor();
  await page.locator('.tlist li').first().waitFor({ timeout: 10000 });
  assert.ok(await page.locator('.tlist li').count() > 5);
});

test('simulated traffic fills a project; settings change sampling; sign out', async () => {
  await page.getByRole('link', { name: 'Load test' }).click();
  await page.getByRole('button', { name: 'Start simulated traffic' }).click();
  await page.getByText(/Running/).waitFor();
  await page.getByRole('button', { name: 'Stop' }).click();
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByLabel(/Keep \d+% of healthy requests/).fill('25');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await page.getByText('Saved.').waitFor();
  const p = await ctx.projects.get(projectId);
  assert.equal(p.settings.normal_sampling_rate, 0.25);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
});

test('no JavaScript errors on any page', () => {
  assert.deepEqual(pageErrors, []);
});
