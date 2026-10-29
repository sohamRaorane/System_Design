'use strict';
// Connect a repository: stack detection, file patches, and the pull request flow end to end
// against a fake GitHub.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { harness } = require('./helpers');
const { fakeGitHub } = require('./fakeGithub');
const { detectStack, patchPackageJson, patchRequirements, patchProcfile, planInstrumentation, NODE_REGISTER } = require('../src/github/instrument');

// ---------------- pure planning ----------------
test('detectStack recognises Node, Python, Go, Java and unknown', () => {
  assert.deepEqual(detectStack({ 'package.json': '{"dependencies":{"express":"^5"}}' }), { language: 'node', framework: 'express', label: 'Node.js (express)' });
  assert.equal(detectStack({ 'requirements.txt': 'Django==5.0\n' }).label, 'Python (django)');
  assert.equal(detectStack({ 'pyproject.toml': '[project]\ndependencies=["fastapi"]' }).framework, 'fastapi');
  assert.equal(detectStack({ 'go.mod': 'module x' }).language, 'go');
  assert.equal(detectStack({ 'pom.xml': '<project/>' }).language, 'java');
  assert.equal(detectStack({}).language, 'unknown');
});

test('package.json: adds packages, preloads them in a plain node start script, keeps indentation', () => {
  const src = '{\n    "name": "shop",\n    "scripts": { "start": "node server.js" },\n    "dependencies": { "express": "^5.1.0" }\n}\n';
  const r = patchPackageJson(src);
  const pkg = JSON.parse(r.content);
  assert.equal(pkg.scripts.start, `node --require ${NODE_REGISTER} server.js`);
  assert.ok(pkg.dependencies['@opentelemetry/api'] && pkg.dependencies['@opentelemetry/auto-instrumentations-node']);
  assert.deepEqual(Object.keys(pkg.dependencies), [...Object.keys(pkg.dependencies)].sort());
  assert.ok(r.content.startsWith('{\n    "name"'), '4-space indentation preserved');
  assert.ok(r.content.endsWith('}\n'));
  assert.equal(JSON.parse(patchPackageJson(r.content).content).scripts.start, pkg.scripts.start, 'idempotent');
  const next = patchPackageJson('{"scripts":{"start":"next start"}}');
  assert.equal(JSON.parse(next.content).scripts.start, 'next start', 'framework CLIs are left alone');
  assert.match(next.notes[0], /NODE_OPTIONS/);
  assert.equal(JSON.parse(patchPackageJson('{"scripts":{"start":"node a.js && node b.js"}}').content).scripts.start, 'node a.js && node b.js');
});

test('Python: requirements and Procfile patched once', () => {
  const r = patchRequirements('flask==3.0\nopentelemetry-distro>=0.40\n');
  assert.equal(r.content, 'flask==3.0\nopentelemetry-distro>=0.40\nopentelemetry-exporter-otlp\n');
  assert.equal(patchRequirements(r.content).changed, false);
  const p = patchProcfile('web: gunicorn app:app\nworker: python worker.py');
  assert.equal(p.content, 'web: opentelemetry-instrument gunicorn app:app\nworker: python worker.py');
  assert.equal(patchProcfile(p.content).changed, false);
});

test('plan: guide always added, never contains a secret; unknown stacks get docs only', () => {
  const plan = planInstrumentation({ 'go.mod': 'module x' }, { serviceName: 'api', endpoint: 'https://c.example' });
  assert.deepEqual(plan.changes.map((c) => c.path), ['OPENTELEMETRY.md']);
  assert.match(plan.changes[0].content, /OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/c\.example/);
  assert.match(plan.changes[0].content, /OTEL_SERVICE_NAME=api/);
  assert.ok(!/otk_/.test(plan.changes[0].content));
});

// ---------------- HTTP flow ----------------
const appKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
let gh, h, url, token, devToken;

before(async () => {
  gh = fakeGitHub({ repos: {
    'octo-dev/shop': { default_branch: 'main', language: 'JavaScript', files: { 'package.json': '{\n  "name": "shop",\n  "scripts": {\n    "start": "node index.js"\n  },\n  "dependencies": {\n    "express": "^5.1.0"\n  }\n}\n' } },
    'octo-dev/api': { default_branch: 'trunk', files: { 'requirements.txt': 'fastapi\n', Procfile: 'web: uvicorn main:app' } },
  } });
  const ghUrl = await gh.start();
  h = await harness({ env: {
    devLogin: true, githubEnabled: true, githubAppEnabled: true, webOrigin: 'http://web.test', publicUrl: 'https://collector.example',
    github: { clientId: 'cid', clientSecret: 'sec', appId: '123', appSlug: 'tracepipe-test', appPrivateKey: appKey.export({ type: 'pkcs8', format: 'pem' }), apiUrl: ghUrl, webUrl: ghUrl },
  } });
  url = await h.listen();
  // sign in through GitHub so the user has a GitHub token
  const start = await fetch(url + '/api/auth/github/start', { redirect: 'manual' });
  const state = new URL(start.headers.get('location')).searchParams.get('state');
  const cookie = start.headers.getSetCookie()[0].split(';')[0];
  const cb = await fetch(`${url}/api/auth/github/callback?code=good-code&state=${state}`, { redirect: 'manual', headers: { cookie } });
  const refresh = cb.headers.getSetCookie().find((c) => c.startsWith('tp_refresh=')).split(';')[0];
  token = (await (await fetch(url + '/api/auth/refresh', { method: 'POST', headers: { cookie: refresh, 'x-requested-with': 't' } })).json()).access_token;
  devToken = (await (await fetch(url + '/api/auth/dev-login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 't' }, body: '{"login":"localdev"}' })).json()).access_token;
});
after(async () => { await h.cleanup(); await gh.close(); });

const api = async (tok, path, { method = 'GET', body } = {}) => {
  const r = await fetch(url + path, { method, headers: { authorization: 'Bearer ' + tok, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('installations and repositories are listed with the user token; install URL carries the return path', async () => {
  const inst = await api(token, '/api/github/installations?next=/p/x/connect');
  assert.equal(inst.status, 200);
  assert.equal(inst.body.installations[0].id, 77);
  assert.match(inst.body.install_url, /\/apps\/tracepipe-test\/installations\/new\?state=%2Fp%2Fx%2Fconnect$/);
  const repos = await api(token, '/api/github/installations/77/repos');
  assert.deepEqual(repos.body.repos.map((r) => r.full_name).sort(), ['octo-dev/api', 'octo-dev/shop']);
  assert.ok(gh.calls.filter((c) => c.path.startsWith('/user/installations')).every((c) => c.auth === 'gho_user_token_123'));
  const setup = await fetch(url + '/api/github/setup?installation_id=77&state=/p/x/connect', { redirect: 'manual' });
  assert.equal(setup.headers.get('location'), 'http://web.test/p/x/connect');
});

test('users signed in without GitHub are asked to sign in with GitHub', async () => {
  const r = await api(devToken, '/api/github/installations');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'github_sign_in_required');
});

test('connect a Node repo, open the pull request: files on a new branch, no secrets, PR recorded', async () => {
  const p = (await api(token, '/api/projects', { method: 'POST', body: { name: 'Shop' } })).body;
  const pid = p.project.id;
  const linked = await api(token, `/api/projects/${pid}/repo`, { method: 'POST', body: { installation_id: 77, full_name: 'octo-dev/shop' } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.stack.label, 'Node.js (express)');
  assert.deepEqual(linked.body.changes.map((c) => c.path), ['package.json', 'OPENTELEMETRY.md']);

  const pr = await api(token, `/api/projects/${pid}/repo/pull-request`, { method: 'POST', body: { service_name: 'Shop Web' } });
  assert.equal(pr.status, 201);
  assert.equal(pr.body.pull_request.branch, 'tracepipe/opentelemetry');
  assert.equal(pr.body.service_name, 'shop-web');
  const created = gh.state.pulls[0];
  assert.deepEqual([created.base, created.head, created.title], ['main', 'tracepipe/opentelemetry', 'Add OpenTelemetry tracing']);
  const files = gh.state.repos['octo-dev/shop'].branchFiles['tracepipe/opentelemetry'];
  assert.equal(JSON.parse(files['package.json']).scripts.start, `node --require ${NODE_REGISTER} index.js`);
  assert.match(files['OPENTELEMETRY.md'], /OTEL_EXPORTER_OTLP_ENDPOINT=https:\/\/collector\.example/);
  assert.match(files['OPENTELEMETRY.md'], /OTEL_SERVICE_NAME=shop-web/);
  assert.ok(!JSON.stringify(files).includes(p.key.value) && !/otk_/.test(JSON.stringify(files) + created.body), 'the ingest key never goes into the repository');
  assert.equal(gh.state.repos['octo-dev/shop'].files['package.json'].includes('opentelemetry'), false, 'default branch untouched');
  // writes used the installation token, never the user token
  assert.ok(gh.calls.filter((c) => c.method === 'PUT' || (c.method === 'POST' && c.path.includes('/repos/'))).every((c) => c.auth === 'ghs_install_77'));
  // the App JWT is signed with the App key and names the App
  const appCall = gh.calls.find((c) => c.path === '/app/installations/77/access_tokens');
  const [hh, pl, sig] = appCall.auth.split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${hh}.${pl}`), crypto.createPublicKey(appKey), Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(pl, 'base64url')).iss, '123');

  const proj = await api(token, `/api/projects/${pid}`);
  assert.equal(proj.body.project.repo.full_name, 'octo-dev/shop');
  assert.equal(proj.body.project.repo.pr_url, created.html_url);
  // a second PR uses a fresh branch name
  const again = await api(token, `/api/projects/${pid}/repo/pull-request`, { method: 'POST', body: {} });
  assert.equal(again.body.pull_request.branch, 'tracepipe/opentelemetry-2');
});

test('Python repo: requirements and Procfile changed on a non-main default branch', async () => {
  const pid = (await api(token, '/api/projects', { method: 'POST', body: { name: 'API' } })).body.project.id;
  await api(token, `/api/projects/${pid}/repo`, { method: 'POST', body: { installation_id: 77, full_name: 'octo-dev/api' } });
  const pr = await api(token, `/api/projects/${pid}/repo/pull-request`, { method: 'POST', body: {} });
  assert.equal(pr.status, 201);
  assert.equal(gh.state.pulls.at(-1).base, 'trunk');
  const files = gh.state.repos['octo-dev/api'].branchFiles[pr.body.pull_request.branch];
  assert.match(files['requirements.txt'], /opentelemetry-distro\nopentelemetry-exporter-otlp\n$/);
  assert.equal(files.Procfile, 'web: opentelemetry-instrument uvicorn main:app');
});

test('repositories outside the user\'s installations and other people\'s projects are refused', async () => {
  const pid = (await api(token, '/api/projects', { method: 'POST', body: { name: 'X' } })).body.project.id;
  const r = await api(token, `/api/projects/${pid}/repo`, { method: 'POST', body: { installation_id: 77, full_name: 'someone/else' } });
  assert.equal(r.status, 404);
  assert.equal((await api(token, `/api/projects/${pid}/repo`, { method: 'POST', body: { installation_id: 77, full_name: '../etc' } })).status, 400);
  assert.equal((await api(devToken, `/api/projects/${pid}/repo/pull-request`, { method: 'POST', body: {} })).status, 404);
  assert.equal((await api(token, `/api/projects/${pid}/repo/pull-request`, { method: 'POST', body: {} })).status, 400, 'no repo linked yet');
});
