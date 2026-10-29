'use strict';
// Cold archive on S3-compatible storage (Cloudflare R2): SigV4 against the AWS test suite,
// and the archive worker + cold reads through a signature-checking fake S3.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { harness, fakeTrace } = require('./helpers');
const { fakeS3 } = require('./fakeS3');
const { signRequest } = require('../src/blob/sigv4');
const { S3BlobStore } = require('../src/blob/s3Store');

const AWS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', date: new Date('2015-08-30T12:36:00Z') };

test('SigV4 matches the AWS test suite (get-vanilla, get-vanilla-query-order-key-case)', () => {
  const a = signRequest({ ...AWS, method: 'GET', url: new URL('https://example.amazonaws.com/') });
  assert.equal(a.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const b = signRequest({ ...AWS, method: 'GET', url: new URL('https://example.amazonaws.com/?Param2=value2&Param1=value1') });
  assert.equal(b._debug.signature, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
});

let s3, h, store;
const DAY = 86400000;
before(async () => {
  s3 = fakeS3();
  const url = await s3.start();
  store = new S3BlobStore({ endpoint: url, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey, prefix: 'archive/' });
  h = await harness({ blob: store });
});
after(async () => { await h.cleanup(); await s3.close(); });

test('object store basics: put, get, list day prefixes, remove a prefix', async () => {
  await store.check();
  await store.put('2026-01-01/a.json.gz', Buffer.from('one'));
  await store.put('2026-01-02/b.json.gz', Buffer.from('two'));
  assert.equal((await store.get('2026-01-01/a.json.gz')).toString(), 'one');
  assert.deepEqual((await store.listPrefixes()).sort(), ['2026-01-01/', '2026-01-02/']);
  await store.removePrefix('2026-01-01/');
  assert.deepEqual(await store.listPrefixes(), ['2026-01-02/']);
  assert.ok([...s3.objects.keys()].every((k) => k.startsWith('archive/')), 'everything lives under the configured prefix');
  const bad = new S3BlobStore({ endpoint: s3.url, bucket: s3.bucket, accessKeyId: s3.accessKeyId, secretAccessKey: 'wrong', prefix: 'archive/' });
  await assert.rejects(bad.check(), /403 SignatureDoesNotMatch/);
});

test('archive worker writes to the object store; cold reads come back from it', async () => {
  const old = Date.now() - 3 * DAY;
  h.ctx.config.update({ hot_retention_days: 1 });
  await h.ctx.repo.insertBatch([fakeTrace('s3-a', { finalized: old, reason: 'ERROR', status: 'ERROR' }), fakeTrace('s3-b', { finalized: old + 1 })]);
  const r = await h.ctx.archiver.runOnce();
  assert.deepEqual([r.ok, r.archived], [true, 2]);
  const entry = await h.ctx.repo.getArchiveEntry('default', 's3-a');
  assert.ok(s3.objects.has('archive/' + entry.object_key));
  h.ctx.coldReader.cache.clear();
  const cold = await h.ctx.coldReader.read('default', 's3-b');
  assert.equal(cold.trace.trace_id, 's3-b');
});

test('object store outage: archive run fails safely, hot rows stay, retry succeeds', async () => {
  const old = Date.now() - 3 * DAY;
  await h.ctx.repo.insertBatch([fakeTrace('s3-c', { finalized: old })]);
  s3.failNext(1);
  const r = await h.ctx.archiver.runOnce();
  assert.equal(r.ok, false);
  assert.match(r.error, /503 SlowDown/);
  assert.ok(await h.ctx.repo.getHot('default', 's3-c'), 'still in hot storage');
  assert.equal((await h.ctx.archiver.runOnce()).archived, 1);
  assert.equal(await h.ctx.repo.getHot('default', 's3-c'), null);
});
