'use strict';
// Sign-in and sessions (/api/auth/*) and the public key set (/.well-known/jwks.json).
//
// Flow: GitHub OAuth -> we create a session (rotating refresh token in an httpOnly cookie
// scoped to /api/auth) -> the dashboard calls /api/auth/refresh to get a short-lived RS256
// access token it keeps in memory and sends as "Authorization: Bearer".
const express = require('express');
const crypto = require('node:crypto');
const { parseCookies, serializeCookie } = require('../util/cookies');
const { isAdminLogin } = require('./middleware');

const REFRESH_COOKIE = 'tp_refresh';
const STATE_COOKIE = 'tp_oauth';
const ACCESS_TTL_S = 15 * 60;
const CSRF_HEADER = 'x-requested-with';

/** Only same-site relative paths are allowed as post-login destinations (no open redirect). */
function safeNext(next) {
  const n = String(next || '/');
  return n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/\\') ? n.slice(0, 500) : '/';
}

function authRouter(ctx) {
  const { env, accounts, jwt, github, logger } = ctx;
  const router = express.Router();
  const cookieOpts = { secure: env.cookieSecure, path: '/api/auth', sameSite: 'Lax' };
  const callbackUrl = () => `${env.webOrigin || env.publicUrl}/api/auth/github/callback`;

  const issue = (user) => {
    const admin = isAdminLogin(env, user.login);
    const token = jwt.sign({ sub: user.id, login: user.login, adm: admin, typ: 'access' }, { expiresInS: ACCESS_TTL_S });
    return { access_token: token, token_type: 'Bearer', expires_in: ACCESS_TTL_S, user: publicUser(user, admin) };
  };

  const setRefresh = (res, session) => res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, session.token, { ...cookieOpts, maxAgeS: session.maxAgeS }));
  const clearRefresh = (res) => res.append('Set-Cookie', serializeCookie(REFRESH_COOKIE, '', { ...cookieOpts, maxAgeS: 0 }));

  // Cookie-authenticated POSTs must carry a custom header: a cross-site form cannot set it,
  // and we never enable CORS, so a cross-site script cannot either.
  const csrf = (req, res, next) => {
    if (!req.get(CSRF_HEADER)) return res.status(403).json({ error: 'csrf', message: `missing ${CSRF_HEADER} header` });
    next();
  };

  router.get('/.well-known/jwks.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(jwt.jwks());
  });

  router.get('/api/auth/config', (req, res) => {
    res.json({ github: env.githubEnabled, devLogin: env.devLogin, githubApp: env.githubAppEnabled, appSlug: env.github.appSlug || null });
  });

  router.get('/api/auth/github/start', (req, res) => {
    if (!env.githubEnabled) return res.status(503).json({ error: 'github_not_configured', message: 'Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET on the collector.' });
    const state = crypto.randomBytes(16).toString('base64url');
    const next = safeNext(req.query.next);
    res.append('Set-Cookie', serializeCookie(STATE_COOKIE, `${state}|${next}`, { ...cookieOpts, maxAgeS: 600 }));
    res.redirect(302, github.authorizeUrl({ redirectUri: callbackUrl(), state }));
  });

  router.get('/api/auth/github/callback', async (req, res) => {
    const fail = (reason) => res.redirect(302, `${env.webOrigin || ''}/login?error=${encodeURIComponent(reason)}`);
    const [state, next] = String(parseCookies(req.get('cookie'))[STATE_COOKIE] || '').split('|');
    res.append('Set-Cookie', serializeCookie(STATE_COOKIE, '', { ...cookieOpts, maxAgeS: 0 }));
    if (req.query.error) return fail(String(req.query.error_description || req.query.error));
    if (!state || !req.query.state || state !== req.query.state) return fail('Sign-in expired or was started in another browser. Try again.');
    try {
      const tok = await github.exchangeCode({ code: String(req.query.code || ''), redirectUri: callbackUrl() });
      const profile = await github.getUser(tok.access_token);
      const user = await accounts.upsertGithubUser(profile, tok.access_token);
      setRefresh(res, await accounts.createSession(user.id, req.get('user-agent')));
      logger?.info?.(`sign-in: ${user.login}`);
      res.redirect(302, `${env.webOrigin || ''}${safeNext(next)}`);
    } catch (err) {
      logger?.warn?.('GitHub sign-in failed:', err.message);
      fail('GitHub sign-in failed: ' + err.message);
    }
  });

  router.post('/api/auth/refresh', csrf, async (req, res) => {
    const token = parseCookies(req.get('cookie'))[REFRESH_COOKIE];
    const rotated = await accounts.rotateSession(token, req.get('user-agent'));
    if (!rotated) {
      if (token) clearRefresh(res);
      return res.status(401).json({ error: 'signed_out' });
    }
    setRefresh(res, rotated);
    res.json(issue(rotated.user));
  });

  router.post('/api/auth/logout', csrf, async (req, res) => {
    await accounts.deleteSession(parseCookies(req.get('cookie'))[REFRESH_COOKIE]);
    clearRefresh(res);
    res.json({ ok: true });
  });

  router.get('/api/auth/me', ctx.auth.requireUser, async (req, res) => {
    const user = await accounts.getUser(req.user.id);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    res.json({ user: publicUser(user, req.user.admin) });
  });

  if (env.devLogin) {
    // Local development and automated tests only; disabled whenever NODE_ENV=production.
    router.post('/api/auth/dev-login', csrf, express.json({ limit: '10kb' }), async (req, res) => {
      const login = String(req.body?.login || '').trim().toLowerCase();
      if (!/^[a-z0-9-]{1,39}$/.test(login)) return res.status(400).json({ error: 'invalid_login', message: 'Use letters, digits and dashes.' });
      const user = await accounts.upsertDevUser(login);
      setRefresh(res, await accounts.createSession(user.id, req.get('user-agent')));
      res.json(issue(user));
    });
  }

  return router;
}

function publicUser(u, admin) {
  return { id: u.id, login: u.login, name: u.name, avatar_url: u.avatar_url, admin: Boolean(admin), github: Boolean(u.github_id) };
}

module.exports = { authRouter, REFRESH_COOKIE, safeNext };
