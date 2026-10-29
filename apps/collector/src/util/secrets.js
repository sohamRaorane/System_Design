'use strict';
// Small crypto helpers: random ids/tokens, hashing for stored secrets, and AES-256-GCM
// encryption for third-party tokens kept at rest (GitHub user tokens).
const crypto = require('node:crypto');

const randomId = (prefix, bytes = 9) => `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

class SecretBox {
  /** @param {crypto.KeyObject|string|Buffer} material  anything secret; a 256-bit key is derived from it */
  constructor(material) {
    const raw = typeof material === 'object' && material?.export ? material.export({ type: 'pkcs8', format: 'der' }) : Buffer.from(String(material));
    this.key = Buffer.from(crypto.hkdfSync('sha256', raw, Buffer.from('tracepipe'), Buffer.from('token-encryption-v1'), 32));
  }

  seal(plaintext) {
    if (plaintext === null || plaintext === undefined) return null;
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
  }

  open(sealed) {
    if (!sealed) return null;
    const [v, iv, tag, enc] = String(sealed).split('.');
    if (v !== 'v1') throw new Error('unknown sealed format');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
  }
}

module.exports = { randomId, randomToken, sha256, safeEqualHex, SecretBox };
