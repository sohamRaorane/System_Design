'use strict';
// Sign-in, sessions, JWT/JWKS, admin guards.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { harness } = require('./helpers');
const { fakeGitHub } = require('./fakeGithub');
const { Jwt, thumbprint } = require('../src/auth/jwt');
const { SecretBox } = require('../src/util/secrets');
const { readEnv, productionProblems } = require('../src/env');
const { safeNext } = require('../src/auth/routes');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

test('JWT: sign/verify round trip; JWKS publishes the public key with an RFC 7638 kid', () => {
  const jwt = new Jwt({ privateKey: key });
  const p = jwt.verify(jwt.sign({ sub: 'u1', typ: 'access' }));
  assert.equal(p.sub, 'u1');
  const [k] = jwt.jwks().keys;
  assert.equal(k.kid, jwt.kid);
  assert.equal(k.kid, thumbprint(k));
  assert.deepEqual([k.kty, k.alg, k.use], ['RSA', 'RS256', 'sig']);
  assert.ok(!('d' in k), 'private part never published');
  // the published JWK verifies a token on its own (what any other service would do)
  const pub = crypto.createPublicKey({ key: k, format: 'jwk' });
  const [h, pl, s] = jwt.sign({ sub: 'x' }).split('.');
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${pl}`), pub, Buffer.from(s, 'base64url')));
});

test('JWT: rejects tampering, alg=none, HS256 key confusion, expiry, wrong audience, unknown kid', () => {
  let now = 1_800_000_000_000;
  const jwt = new Jwt({ privateKey: key, clock: { now: () => now } });
  const good = jwt.sign({ sub: 'u1' }, { expiresInS: 60 });
  const [h, p, s] = good.split('.');
  const expect = (tok, code) => assert.throws(() => jwt.verify(tok), (e) => e.code === code, code);
  expect(`${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url')), sub: 'admin' })}.${s}`, 'signature');
  expect(`${b64({ alg: 'none', typ: 'JWT', kid: jwt.kid })}.${p}.`, 'alg');
  const pubPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const hsHeader = b64({ alg: 'HS256', typ: 'JWT', kid: jwt.kid });
  const hsSig = crypto.createHmac('sha256', pubPem).update(`${hsHeader}.${p}`).digest('base64url');
  expect(`${hsHeader}.${p}.${hsSig}`, 'alg');
  expect(`${b64({ alg: 'RS256', kid: 'nope' })}.${p}.${s}`, 'kid');
  expect('a.b', 'malformed');
  const other = new Jwt({ privateKey: key, audience: 'someone-else', clock: { now: () => now } });
  expect(other.sign({ sub: 'u1' }), 'aud');
  now += 61_000 + 30_000;
  expect(good, 'expired');
});

test('JWT: tokens signed by a rotated-out key still verify via JWT_PREVIOUS_PUBLIC_KEYS', () => {
  const old = new Jwt({ privateKey: key });
  const token = old.sign({ sub: 'u1' });
  const newKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const rotated = new Jwt({ privateKey: newKey, previousPublicKeys: [crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })] });
  assert.equal(rotated.verify(token).sub, 'u1');
  assert.equal(rotated.jwks().keys.length, 2);
  assert.throws(() => new Jwt({ privateKey: newKey }).verify(token), (e) => e.code === 'kid');
});

test('SecretBox: round trip, and tampering is detected', () => {
  const box = new SecretBox(key);
  const sealed = box.seal('gho_secret');
  assert.ok(!sealed.includes('gho_secret'));
  assert.equal(box.open(sealed), 'gho_secret');
  const parts = sealed.split('.');
  parts[3] = Buffer.from('xxxxxxxxxx').toString('base64url');
  assert.throws(() => box.open(parts.join('.')));
});

test('safeNext blocks open redirects', () => {
  assert.equal(safeNext('/p/abc/traces?x=1'), '/p/abc/traces?x=1');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) assert.equal(safeNext(bad), '/');
});

test('production refuses unsafe configuration', () => {
  const problems = productionProblems(readEnv({ NODE_ENV: 'production' }));
  for (const word of ['DATABASE_URL', 'JWT_PRIVATE_KEY', 'ADMIN_TOKEN', 'WEB_ORIGIN', 'GITHUB_CLIENT_ID']) assert.ok(problems.some((p) => p.includes(word)), word);
  assert.equal(readEnv({ NODE_ENV: 'production', DEV_LOGIN: 'true' }).devLogin, false, 'dev login can never be on in production');
  assert.equal(readEnv({ NODE_ENV: 'production' }).allowAnonymousIngest, false);
  assert.equal(readEnv({ JWT_PRIVATE_KEY: 'a\\nb' }).jwtPrivateKey, 'a\nb', 'escaped newlines restored');
});

// ---------------- HTTP flows ----------------
let gh, h, url;
before(async () => {
  gh = fakeGitHub();
  const ghUrl = await gh.start();
  h = await harness({
    env: { devLogin: true, githubEnabled: true, adminLogins: ['octo-dev'], webOrigin: 'http://web.test', github: { clientId: 'cid', clientSecret: 'csecret', apiUrl: ghUrl, webUrl: ghUrl } },
  });
  url = await h.listen();
});
after(async () => { await h.cleanup(); await gh.close(); });

const cookieFrom = (res, name) => {
  const all = res.headers.getSetCookie();
  const c = all.find((x) => x.startsWith(name + '='));
  return c ? c.split(';')[0] : null;
};
const post = (p, { cookie, body, csrf = true, token } = {}) => fetch(url + p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(csrf ? { 'x-requested-with': 'tracepipe' } : {}), ...(cookie ? { cookie } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('GitHub sign-in: state cookie, code exchange, user stored, session cookie, redirect to next', async () => {
  const start = await fetch(url + '/api/auth/github/start?next=/p/x/traces', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.pathname, '/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'cid');
  assert.equal(loc.searchParams.get('redirect_uri'), 'http://web.test/api/auth/github/callback');
  const stateCookie = cookieFrom(start, 'tp_oauth');
  assert.ok(start.headers.getSetCookie()[0].includes('HttpOnly'));

  const cb = await fetch(`${url}/api/auth/github/callback?code=good-code&state=${loc.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: stateCookie } });
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), 'http://web.test/p/x/traces');
  const refresh = cookieFrom(cb, 'tp_refresh');
  assert.ok(refresh);
  const setCookie = cb.headers.getSetCookie().find((c) => c.startsWith('tp_refresh='));
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Path=\/api\/auth/);
  assert.match(setCookie, /SameSite=Lax/);

  const r = await post('/api/auth/refresh', { cookie: refresh });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.user.login, 'octo-dev');
  assert.equal(body.user.admin, true);
  assert.equal(body.user.github, true);
  const row = await h.ctx.db.get("SELECT github_token FROM users WHERE login = 'octo-dev'");
  assert.ok(row.github_token && !row.github_token.includes('gho_user_token_123'), 'GitHub token encrypted at rest');
  assert.equal(await h.ctx.accounts.githubToken(body.user.id), 'gho_user_token_123');
  const me = await fetch(url + '/api/auth/me', { headers: { authorization: 'Bearer ' + body.access_token } });
  assert.equal((await me.json()).user.login, 'octo-dev');
});

test('GitHub sign-in: wrong state or bad code returns to /login with a reason', async () => {
  const cb = await fetch(`${url}/api/auth/github/callback?code=good-code&state=forged`, { redirect: 'manual', headers: { cookie: 'tp_oauth=real|/' } });
  assert.match(cb.headers.get('location'), /^http:\/\/web\.test\/login\?error=/);
  const start = await fetch(url + '/api/auth/github/start', { redirect: 'manual' });
  const st = new URL(start.headers.get('location')).searchParams.get('state');
  const bad = await fetch(`${url}/api/auth/github/callback?code=wrong&state=${st}`, { redirect: 'manual', headers: { cookie: cookieFrom(start, 'tp_oauth') } });
  assert.match(decodeURIComponent(bad.headers.get('location')), /incorrect or expired/);
});

test('sessions rotate: each refresh token works once; logout ends the session; CSRF header required', async () => {
  const login = await post('/api/auth/dev-login', { body: { login: 'alice' } });
  assert.equal(login.status, 200);
  const first = cookieFrom(login, 'tp_refresh');
  assert.equal((await post('/api/auth/refresh', { cookie: first, csrf: false })).status, 403, 'no CSRF header');
  const r1 = await post('/api/auth/refresh', { cookie: first });
  assert.equal(r1.status, 200);
  const second = cookieFrom(r1, 'tp_refresh');
  assert.notEqual(second, first);
  assert.equal((await post('/api/auth/refresh', { cookie: first })).status, 401, 'used token rejected');
  assert.equal((await post('/api/auth/logout', { cookie: second })).status, 200);
  assert.equal((await post('/api/auth/refresh', { cookie: second })).status, 401, 'logged out');
});

test('JWKS endpoint and /api/auth/me guard', async () => {
  const jwks = await (await fetch(url + '/.well-known/jwks.json')).json();
  assert.equal(jwks.keys[0].kid, h.ctx.jwt.kid);
  assert.equal((await fetch(url + '/api/auth/me')).status, 401);
  assert.equal((await fetch(url + '/api/auth/me', { headers: { authorization: 'Bearer not.a.jwt' } })).status, 401);
  const refreshTyp = h.ctx.jwt.sign({ sub: 'x', typ: 'refresh' });
  assert.equal((await fetch(url + '/api/auth/me', { headers: { authorization: 'Bearer ' + refreshTyp } })).status, 401, 'only access tokens are accepted');
});

test('admin guards: operator token or admin user; ordinary users get 403', async () => {
  h.ctx.env.adminToken = 'operator-secret-token-123456';
  try {
    const admin = await (await post('/api/auth/dev-login', { body: { login: 'octo-dev' } })).json();
    const user = await (await post('/api/auth/dev-login', { body: { login: 'bob' } })).json();
    const put = (p, headers) => fetch(url + p, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: '{"normal_sampling_rate":0.2}' });
    assert.equal((await put('/v1/config', {})).status, 401);
    assert.equal((await put('/v1/config', { 'x-admin-token': 'wrong' })).status, 401);
    assert.equal((await put('/v1/config', { 'x-admin-token': 'operator-secret-token-123456' })).status, 200);
    assert.equal((await put('/api/admin/config', { authorization: 'Bearer ' + user.access_token })).status, 403);
    assert.equal((await put('/api/admin/config', { authorization: 'Bearer ' + admin.access_token })).status, 200);
    assert.equal((await fetch(url + '/metrics')).status, 401, 'operator metrics need the token');
    assert.equal((await fetch(url + '/api/pipeline', { headers: { authorization: 'Bearer ' + user.access_token } })).status, 200);
    assert.equal((await fetch(url + '/v1/traces')).status, 401, 'operator trace API guarded');
  } finally {
    h.ctx.env.adminToken = '';
  }
});
