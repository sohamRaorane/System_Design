'use strict';
// Request guards.
//   requireUser  — a valid access token (Authorization: Bearer <jwt>) for a dashboard user
//   requireAdmin — an admin user, or the operator X-Admin-Token
//   operatorGuard — legacy /v1 operator API: X-Admin-Token or admin user; open only when no
//                   ADMIN_TOKEN is configured (local development and tests)
const crypto = require('node:crypto');

function bearer(req) {
  const h = String(req.get('authorization') || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function authMiddleware(ctx) {
  /** Attach req.user if a valid token is present; never rejects. */
  const identify = (req) => {
    if (req.user !== undefined) return req.user;
    req.user = null;
    const token = bearer(req);
    if (!token || token.startsWith('otk_') || !ctx.jwt) return null;
    try {
      const p = ctx.jwt.verify(token);
      if (p.typ !== 'access') return null;
      req.user = { id: p.sub, login: p.login, admin: Boolean(p.adm) };
    } catch {
      req.user = null;
    }
    return req.user;
  };

  const requireUser = (req, res, next) => {
    if (!identify(req)) return res.status(401).json({ error: 'unauthorized', message: 'Sign in again: your session is missing or expired.' });
    next();
  };

  const isOperator = (req) => tokenMatches(req.get('x-admin-token'), ctx.env.adminToken);

  const requireAdmin = (req, res, next) => {
    if (isOperator(req)) return next();
    const u = identify(req);
    if (!u) return res.status(401).json({ error: 'unauthorized' });
    if (!u.admin) return res.status(403).json({ error: 'forbidden', message: 'Only administrators can do this.' });
    next();
  };

  const operatorGuard = (req, res, next) => {
    if (!ctx.env.adminToken) return next();
    if (isOperator(req)) return next();
    const u = identify(req);
    if (u?.admin) return next();
    res.status(401).json({ error: 'unauthorized' });
  };

  return { identify, requireUser, requireAdmin, operatorGuard };
}

/** Admins: listed GitHub logins; in development with no list, every user (convenience). */
function isAdminLogin(env, login) {
  if (env.adminLogins.length) return env.adminLogins.includes(String(login).toLowerCase());
  return !env.production;
}

module.exports = { authMiddleware, isAdminLogin, bearer };
