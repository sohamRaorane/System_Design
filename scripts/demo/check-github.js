#!/usr/bin/env node
'use strict';
// Checks the GitHub App settings in .env.demo against GitHub before the demo:
//   node scripts/demo/check-github.js            (reads .env.demo at the repo root)
// It signs an App JWT with the private key, reads the App (slug, permissions,
// installations), and tests the client ID/secret pair. Nothing is changed on GitHub.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const WEB = process.env.GITHUB_WEB_URL || 'https://github.com';
const root = path.resolve(__dirname, '..', '..');
const file = process.argv[2] || path.join(root, '.env.demo');
const ok = (m) => console.log(`  OK    ${m}`);
const bad = (m) => { console.log(`  FIX   ${m}`); process.exitCode = 1; };

function readEnvFile(p) {
  const out = {};
  for (const raw of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

(async () => {
  if (!fs.existsSync(file)) { console.log(`No ${file}. Copy .env.demo.example to .env.demo and fill it in.`); process.exit(1); }
  const e = readEnvFile(file);
  console.log(`Checking GitHub settings from ${file}\n`);

  for (const k of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'GITHUB_APP_ID', 'GITHUB_APP_SLUG']) {
    if (e[k]) ok(`${k} is set`); else bad(`${k} is empty`);
  }
  let pemText = e.GITHUB_APP_PRIVATE_KEY ? e.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n') : '';
  if (!pemText && e.GITHUB_APP_PRIVATE_KEY_FILE) {
    const kp = path.resolve(root, e.GITHUB_APP_PRIVATE_KEY_FILE);
    if (fs.existsSync(kp)) { pemText = fs.readFileSync(kp, 'utf8'); ok(`private key file found: ${kp}`); }
    else bad(`private key file not found: ${kp}`);
  }
  if (!pemText) { bad('no private key (GITHUB_APP_PRIVATE_KEY_FILE)'); return; }

  let key;
  try { key = crypto.createPrivateKey(pemText); ok('private key is a valid RSA key'); } catch (err) { bad(`private key does not parse: ${err.message}`); return; }

  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iat: now - 60, exp: now + 540, iss: String(e.GITHUB_APP_ID) })}`;
  const jwt = `${data}.${crypto.sign('sha256', Buffer.from(data), key).toString('base64url')}`;
  const h = { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json', 'user-agent': 'tracepipe-demo-check', 'x-github-api-version': '2022-11-28' };

  try {
    const r = await fetch(`${API}/app`, { headers: h });
    const a = await r.json();
    if (r.status !== 200) { bad(`GitHub refused the App ID + private key (${r.status} ${a.message}). Check GITHUB_APP_ID, or generate a new private key in the App settings.`); return; }
    ok(`App ID + private key accepted: "${a.name}" owned by ${a.owner && a.owner.login}`);
    if (a.slug === e.GITHUB_APP_SLUG) ok(`slug matches: ${a.slug}`); else bad(`GITHUB_APP_SLUG should be "${a.slug}" (it is "${e.GITHUB_APP_SLUG}")`);
    if (a.client_id === e.GITHUB_CLIENT_ID) ok('client ID belongs to this App'); else bad(`GITHUB_CLIENT_ID should be ${a.client_id}`);
    const p = a.permissions || {};
    for (const [perm, want] of [['contents', 'write'], ['pull_requests', 'write'], ['metadata', 'read']]) {
      if (p[perm] === want || (want === 'read' && p[perm] === 'write')) ok(`permission ${perm}: ${p[perm]}`);
      else bad(`permission ${perm} is "${p[perm] || 'none'}", needs "${want}" (App settings > Permissions & events > Repository permissions, then Save)`);
    }
    const ir = await fetch(`${API}/app/installations`, { headers: h });
    const il = ir.status === 200 ? await ir.json() : [];
    if (il.length) ok(`installed on: ${il.map((i) => i.account && i.account.login).join(', ')}`);
    else console.log('  NOTE  not installed anywhere yet; the dashboard\'s Connect page has an Install button');
  } catch (err) { bad(`could not reach api.github.com: ${err.message}`); return; }

  try {
    const r = await fetch(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'tracepipe-demo-check' },
      body: JSON.stringify({ client_id: e.GITHUB_CLIENT_ID, client_secret: e.GITHUB_CLIENT_SECRET, code: 'tracepipe-check-not-a-real-code' }),
    });
    const o = await r.json();
    if (o.error === 'bad_verification_code') ok('client secret accepted');
    else if (o.error === 'incorrect_client_credentials') bad('client secret is wrong: generate a new one in the App settings (Client secrets) and paste it');
    else console.log(`  NOTE  OAuth check answered: ${JSON.stringify(o)}`);
  } catch (err) { bad(`could not reach github.com: ${err.message}`); }

  console.log('\nIn the App settings, these must be set exactly:');
  console.log('  Callback URL:  http://localhost:4318/api/auth/github/callback');
  console.log('  Setup URL:     http://localhost:4318/api/github/setup   (tick "Redirect on update")');
  console.log(process.exitCode ? '\nSome settings need fixing (FIX lines above).' : '\nAll GitHub settings look right.');
})();
