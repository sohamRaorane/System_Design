'use strict';
// RS256 JSON Web Tokens and a JWKS document, built on node:crypto only (ADR-001, ADR-004).
// Verification is strict: the algorithm is pinned to RS256 (no "none", no HS256 key
// confusion), the key is chosen by kid from our own key set, and exp/nbf/iss/aud are checked.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALG = 'RS256';
const LEEWAY_S = 30;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

/** RFC 7638 JWK thumbprint, used as the key id. */
function thumbprint(jwk) {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function publicEntry(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'RSA') throw new Error('JWT keys must be RSA');
  const kid = thumbprint(jwk);
  return { kid, key: publicKey, jwk: { kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: ALG, use: 'sig' } };
}

/**
 * Load the signing key. In production JWT_PRIVATE_KEY is required; in development a key is
 * generated once and kept next to the database so sessions survive restarts.
 */
function loadSigningKey({ pem, devKeyFile, logger } = {}) {
  if (pem) return crypto.createPrivateKey(pem);
  if (devKeyFile && fs.existsSync(devKeyFile)) return crypto.createPrivateKey(fs.readFileSync(devKeyFile, 'utf8'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  if (devKeyFile) {
    fs.mkdirSync(path.dirname(devKeyFile), { recursive: true });
    fs.writeFileSync(devKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    logger?.info?.(`generated a development JWT signing key at ${devKeyFile}`);
  }
  return privateKey;
}

class JwtError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

class Jwt {
  /**
   * @param {object} o
   * @param {crypto.KeyObject} o.privateKey   current signing key
   * @param {string[]} [o.previousPublicKeys] PEMs still accepted for verification (rotation)
   */
  constructor({ privateKey, previousPublicKeys = [], issuer = 'tracepipe', audience = 'tracepipe-api', clock = { now: () => Date.now() } }) {
    this.privateKey = privateKey;
    this.current = publicEntry(crypto.createPublicKey(privateKey));
    this.keys = new Map([[this.current.kid, this.current]]);
    for (const p of previousPublicKeys.filter(Boolean)) {
      const e = publicEntry(crypto.createPublicKey(p));
      this.keys.set(e.kid, e);
    }
    this.issuer = issuer;
    this.audience = audience;
    this.clock = clock;
  }

  get kid() {
    return this.current.kid;
  }

  sign(claims, { expiresInS = 900 } = {}) {
    const now = Math.floor(this.clock.now() / 1000);
    const header = { alg: ALG, typ: 'JWT', kid: this.current.kid };
    const payload = { iss: this.issuer, aud: this.audience, iat: now, nbf: now, exp: now + expiresInS, ...claims };
    const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('sha256', Buffer.from(data), this.privateKey);
    return `${data}.${b64url(sig)}`;
  }

  /** @returns the payload; throws JwtError otherwise. */
  verify(token) {
    if (typeof token !== 'string') throw new JwtError('malformed', 'token missing');
    const parts = token.split('.');
    if (parts.length !== 3) throw new JwtError('malformed', 'token must have three parts');
    let header;
    let payload;
    try {
      header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      throw new JwtError('malformed', 'token is not valid JSON');
    }
    if (header.alg !== ALG) throw new JwtError('alg', 'unsupported algorithm');
    const entry = this.keys.get(header.kid);
    if (!entry) throw new JwtError('kid', 'unknown signing key');
    const ok = crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), entry.key, fromB64url(parts[2]));
    if (!ok) throw new JwtError('signature', 'bad signature');
    const now = Math.floor(this.clock.now() / 1000);
    if (typeof payload.exp !== 'number' || now > payload.exp + LEEWAY_S) throw new JwtError('expired', 'token expired');
    if (typeof payload.nbf === 'number' && now + LEEWAY_S < payload.nbf) throw new JwtError('nbf', 'token not yet valid');
    if (payload.iss !== this.issuer) throw new JwtError('iss', 'wrong issuer');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(this.audience)) throw new JwtError('aud', 'wrong audience');
    return payload;
  }

  jwks() {
    return { keys: [...this.keys.values()].map((k) => k.jwk) };
  }
}

module.exports = { Jwt, JwtError, loadSigningKey, thumbprint };
