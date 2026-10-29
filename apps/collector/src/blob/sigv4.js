'use strict';
// AWS Signature Version 4 (header-based), as used by S3-compatible stores such as Cloudflare R2.
// Verified against the AWS SigV4 test suite ("get-vanilla") in test/blob.test.js.
const crypto = require('node:crypto');

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding as SigV4 requires (keeps A-Z a-z 0-9 - _ . ~). */
function uriEncode(str, encodeSlash = true) {
  return String(str).replace(/[^A-Za-z0-9\-_.~/]/g, (c) => Buffer.from(c, 'utf8').toString('hex').toUpperCase().replace(/(..)/g, '%$1'))
    .replace(/\//g, encodeSlash ? '%2F' : '/');
}

function amzDate(d) {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Sign a request. Returns the headers to send (including Authorization).
 * @param {object} r
 * @param {string} r.method
 * @param {URL} r.url
 * @param {object} [r.headers]    extra headers to sign (lower-case names)
 * @param {Buffer|string} [r.body]
 * @param {string} [r.payloadHash] precomputed hex SHA-256 of the body ('UNSIGNED-PAYLOAD' allowed)
 */
function signRequest({ method, url, headers = {}, body = '', payloadHash, region, service = 's3', accessKeyId, secretAccessKey, date = new Date(), sessionToken }) {
  const t = amzDate(date);
  const day = t.slice(0, 8);
  const hash = payloadHash || sha256hex(body);
  const h = { host: url.host, 'x-amz-date': t, ...lower(headers) };
  if (service === 's3') h['x-amz-content-sha256'] = hash;
  if (sessionToken) h['x-amz-security-token'] = sessionToken;
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(h[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const path = service === 's3' ? uriEncode(decodeURIComponent(url.pathname), false) : url.pathname;
  const canonicalRequest = [method, path || '/', query, canonicalHeaders, signedHeaders, hash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', t, scope, sha256hex(canonicalRequest)].join('\n');
  const kDate = hmac('AWS4' + secretAccessKey, day);
  const kSigning = hmac(hmac(hmac(kDate, region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  const { host, ...rest } = h;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    _debug: { canonicalRequest, stringToSign, signature },
  };
}

function lower(o) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
}

module.exports = { signRequest, sha256hex, uriEncode, amzDate };
