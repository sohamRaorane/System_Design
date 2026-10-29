'use strict';
// Cookie parsing/serialisation without a dependency.

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ }
  }
  return out;
}

function serializeCookie(name, value, { maxAgeS, path = '/', httpOnly = true, secure = false, sameSite = 'Lax' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (maxAgeS !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeS))}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

module.exports = { parseCookies, serializeCookie };
