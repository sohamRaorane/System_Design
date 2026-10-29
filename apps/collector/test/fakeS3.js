'use strict';
// Minimal S3 API fake (path-style): PUT/GET/DELETE object, ListObjectsV2 with delimiter.
// Every request's SigV4 signature is recomputed and must match.
const http = require('node:http');
const { signRequest } = require('../src/blob/sigv4');

function fakeS3({ accessKeyId = 'AKTEST', secretAccessKey = 'secret-test-key', bucket = 'archive-bucket' } = {}) {
  const objects = new Map();
  const calls = [];
  let failNext = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, `http://${req.headers.host}`);
      calls.push({ method: req.method, path: url.pathname, query: url.search });
      if (failNext > 0) { failNext--; res.writeHead(503); return res.end('<Error><Code>SlowDown</Code></Error>'); }
      // signature check
      const auth = String(req.headers.authorization || '');
      const signed = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(';') || [];
      const headers = Object.fromEntries(signed.filter((h) => h !== 'host' && h !== 'x-amz-date' && h !== 'x-amz-content-sha256').map((h) => [h, req.headers[h]]));
      const d = req.headers['x-amz-date'];
      const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
      const expect = signRequest({ method: req.method, url, headers, body, region: 'auto', service: 's3', accessKeyId, secretAccessKey, date });
      if (expect.authorization !== auth) { res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      const [, b, ...rest] = url.pathname.split('/');
      const key = rest.map(decodeURIComponent).join('/');
      if (b !== bucket) { res.writeHead(404); return res.end('<Error><Code>NoSuchBucket</Code></Error>'); }
      if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && key) {
        if (!objects.has(key)) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
        res.writeHead(200); return res.end(objects.get(key));
      }
      if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') || '';
        const delim = url.searchParams.get('delimiter');
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const prefixes = new Set();
        const contents = [];
        for (const k of keys) {
          const restKey = k.slice(prefix.length);
          if (delim && restKey.includes(delim)) prefixes.add(prefix + restKey.slice(0, restKey.indexOf(delim) + 1));
          else contents.push(k);
        }
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`).join('')}${[...prefixes].map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join('')}</ListBucketResult>`);
      }
      res.writeHead(400); res.end();
    });
  });
  return {
    objects, calls, bucket, accessKeyId, secretAccessKey,
    failNext: (n) => { failNext = n; },
    async start() { await new Promise((r) => server.listen(0, '127.0.0.1', r)); this.url = `http://127.0.0.1:${server.address().port}`; return this.url; },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

module.exports = { fakeS3 };
