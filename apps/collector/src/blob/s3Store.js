'use strict';
// S3-compatible object store for the cold archive (Cloudflare R2 by default; also AWS S3,
// MinIO, Backblaze B2). Same interface as LocalBlobStore. Path-style URLs, SigV4 headers.
// R2's free tier: 10 GB-month storage, no egress fees.
const { signRequest, sha256hex } = require('./sigv4');

class S3BlobStore {
  constructor({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, prefix = 'archive/', fetchImpl = fetch, clock = { now: () => Date.now() } }) {
    if (!endpoint || !bucket) throw new Error('S3 store needs an endpoint and a bucket');
    this.kind = 's3';
    this.endpoint = endpoint.replace(/\/+$/, '');
    this.region = region;
    this.bucket = bucket;
    this.creds = { accessKeyId, secretAccessKey };
    this.prefix = prefix.replace(/^\/+/, '');
    this.fetch = fetchImpl;
    this.clock = clock;
  }

  _url(key = '', query) {
    const u = new URL(`${this.endpoint}/${this.bucket}/${key.split('/').map(encodeURIComponent).join('/')}`);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  async _send(method, key, { body, query, headers = {} } = {}) {
    const url = this._url(key, query);
    const payload = body || Buffer.alloc(0);
    const signed = signRequest({
      method, url, headers, body: payload, payloadHash: sha256hex(payload), region: this.region, service: 's3',
      ...this.creds, date: new Date(this.clock.now()),
    });
    delete signed._debug;
    const res = await this.fetch(url, { method, headers: signed, body: method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : payload });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      const err = new Error(`object store ${method} ${key || '(bucket)'} failed: ${res.status}${code ? ' ' + code : ''}`);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async put(key, data) {
    await this._send('PUT', this.prefix + key, { body: Buffer.from(data), headers: { 'content-type': 'application/gzip' } });
  }

  async get(key) {
    const res = await this._send('GET', this.prefix + key);
    return Buffer.from(await res.arrayBuffer());
  }

  async _list(params) {
    const out = { keys: [], prefixes: [] };
    let token;
    do {
      const res = await this._send('GET', '', { query: { 'list-type': '2', ...params, ...(token ? { 'continuation-token': token } : {}) } });
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<\/Contents>/g)) out.keys.push(unxml(m[1]));
      for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>\s*<\/CommonPrefixes>/g)) out.prefixes.push(unxml(m[1]));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] || '') : null;
    } while (token);
    return out;
  }

  /** Day "folders" directly under the archive prefix, e.g. ["2026-10-29/"]. */
  async listPrefixes() {
    const { prefixes } = await this._list({ prefix: this.prefix, delimiter: '/' });
    return prefixes.map((p) => p.slice(this.prefix.length));
  }

  async removePrefix(prefix) {
    const { keys } = await this._list({ prefix: this.prefix + prefix });
    for (const k of keys) await this._send('DELETE', k);
  }

  /** Nothing to clean: object PUTs are atomic. */
  cleanup() {}

  /** Startup check: the bucket is reachable with these credentials. */
  async check() {
    await this._send('GET', '', { query: { 'list-type': '2', prefix: this.prefix, 'max-keys': '1' } });
  }
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

module.exports = { S3BlobStore };
