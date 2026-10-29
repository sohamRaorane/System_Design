'use strict';
// Load-test target safety:
//  * SSRF guard: only http(s) on public addresses; every DNS answer is checked, and the
//    vetted address is pinned for the actual requests (no DNS-rebinding window).
//  * Ownership: you may load-test a host only if you show it is yours, either because this
//    project already receives traces from that host (your instrumented app reported it), or
//    because the host serves this project's token at /.well-known/otel-pipeline.txt.
const dns = require('node:dns');
const net = require('node:net');
const crypto = require('node:crypto');

class TargetError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseTarget(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { throw new TargetError('invalid_url', 'Enter a full URL such as https://your-app.onrender.com/'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new TargetError('invalid_url', 'Only http:// and https:// URLs can be tested.');
  if (u.username || u.password) throw new TargetError('invalid_url', 'URLs with credentials are not allowed.');
  if (!u.hostname) throw new TargetError('invalid_url', 'The URL has no host.');
  u.hash = '';
  return u;
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified ranges. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** Resolve and vet a hostname. Resolves the list of allowed addresses. */
async function vetHost(hostname, { allowPrivate = false, lookup = dns.promises.lookup } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const answers = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new TargetError('dns', `Could not find ${host}. Check the address.`);
  });
  if (!answers.length) throw new TargetError('dns', `Could not find ${host}.`);
  if (!allowPrivate && answers.some((a) => isPrivateAddress(a.address))) {
    throw new TargetError('private_address', `${host} points to a private or internal network address, which cannot be load-tested from here.`);
  }
  return answers;
}

/** A `lookup` for http.request that only ever returns pre-vetted addresses. */
function pinnedLookup(answers) {
  return (hostname, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'object' && opts ? opts : {};
    if (options.all) return callback(null, answers.map((a) => ({ address: a.address, family: a.family })));
    const a = answers[0];
    callback(null, a.address, a.family);
  };
}

/** Stable per-project verification token (no storage needed). */
function verifyToken(secretKeyObject, projectId) {
  const material = secretKeyObject.export({ type: 'pkcs8', format: 'der' });
  return 'tpv_' + crypto.createHmac('sha256', material).update('loadtest-verify:' + projectId).digest('base64url').slice(0, 32);
}

const HOST_ATTRS = ['server.address', 'http.host', 'net.host.name', 'host.name'];
const URL_ATTRS = ['url.full', 'http.url'];

/** Hosts a SERVER span says it served (from standard semantic-convention attributes). */
function hostsFromSpan(span) {
  if (span.kind && span.kind !== 'SERVER') return [];
  const out = new Set();
  const a = span.attributes || {};
  for (const k of HOST_ATTRS) if (typeof a[k] === 'string') out.add(a[k].toLowerCase().replace(/:\d+$/, ''));
  for (const k of URL_ATTRS) {
    if (typeof a[k] === 'string') { try { out.add(new URL(a[k]).hostname.toLowerCase()); } catch { /* not a URL */ } }
  }
  return [...out];
}

module.exports = { TargetError, parseTarget, isPrivateAddress, vetHost, pinnedLookup, verifyToken, hostsFromSpan };
