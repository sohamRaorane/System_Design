'use strict';
// OTLP/HTTP ingest: protobuf (reference fixture encoded by Google's protobuf library),
// OTLP/JSON as the OpenTelemetry JS SDK sends it, partial success, gzip, and the full
// pipeline from OTLP request to stored trace.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { harness } = require('./helpers');
const { decodeExportTraceRequest, encodeExportTraceResponse } = require('../src/ingest/protobuf');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'otlp-trace.pb'));
let h, url;
before(async () => { h = await harness(); url = await h.listen(); });
after(() => h.cleanup());

const queued = () => h.ctx.queue.items.slice(h.ctx.queue.head);
const postRaw = (body, headers) => fetch(url + '/v1/traces', { method: 'POST', headers, body });
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

/** OTLP/JSON exactly as @opentelemetry/exporter-trace-otlp-http serialises it. */
function otlpJson({ traceId = '0af7651916cd43dd8448eb211c80319c', service = 'orders', spans } = {}) {
  const t0 = Date.now();
  return {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }], droppedAttributesCount: 0 },
      scopeSpans: [{
        scope: { name: '@opentelemetry/instrumentation-http', version: '0.57.0' },
        spans: spans || [
          { traceId, spanId: 'b7ad6b7169203331', name: 'GET /orders', kind: 2, startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 40),
            attributes: [{ key: 'http.response.status_code', value: { intValue: 200 } }], droppedAttributesCount: 0, events: [], droppedEventsCount: 0,
            status: { code: 0 }, links: [], droppedLinksCount: 0 },
          { traceId, spanId: '00f067aa0ba902b7', parentSpanId: 'b7ad6b7169203331', name: 'SELECT orders', kind: 3, startTimeUnixNano: ns(t0 + 5), endTimeUnixNano: ns(t0 + 30),
            attributes: [{ key: 'db.system', value: { stringValue: 'postgresql' } }], events: [], status: { code: 0 }, links: [] },
        ],
      }],
    }],
  };
}

test('OTLP protobuf (reference encoding) is decoded and queued with all fields', async () => {
  const before = queued().length;
  const r = await postRaw(FIXTURE, { 'content-type': 'application/x-protobuf' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /application\/x-protobuf/);
  assert.equal((await r.arrayBuffer()).byteLength, 0, 'full success = empty ExportTraceServiceResponse');
  const spans = queued().slice(before);
  assert.equal(spans.length, 2);
  const [root, child] = spans;
  assert.equal(root.trace_id, '5b8efff798038103d269b633813fc60c');
  assert.equal(root.span_id, 'eee19b7ec3c1b174');
  assert.equal(root.parent_span_id, null);
  assert.equal(root.service, 'checkout', 'service.name from the resource, lower-cased');
  assert.equal(root.operation, 'POST /checkout');
  assert.equal(root.kind, 'SERVER');
  assert.equal(root.status, 'ERROR');
  assert.equal(root.status_message, 'upstream failed');
  assert.equal(root.start_time, 1_800_000_000_123);
  assert.equal(root.duration_us, 250_400);
  assert.deepEqual(root.attributes, {
    'http.request.method': 'POST', 'http.response.status_code': 500, 'server.address': 'shop.example.com',
    'sampled.ratio': 0.25, retry: true, negative: -42, tags: '["a",2]',
  });
  assert.equal(root.resource['service.version'], '1.2.3');
  assert.equal(root.project_id, 'default');
  assert.equal(child.parent_span_id, 'eee19b7ec3c1b174');
  assert.equal(child.kind, 'CLIENT');
  assert.equal(child.events[0].name, 'exception');
  assert.equal(child.events[0].attributes['exception.type'], 'CardDeclined');
  assert.equal(h.ctx.metrics.c.requests_by_format['otlp-proto'], 1);
  h.ctx.queue.drainNow();
});

test('OTLP/JSON from the JS SDK (hex ids, string nanos) is accepted with 200 {}', async () => {
  const r = await postRaw(JSON.stringify(otlpJson()), { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {});
  const spans = queued();
  assert.equal(spans.length, 2);
  assert.equal(spans[1].parent_span_id, 'b7ad6b7169203331');
  assert.equal(spans[0].attributes['http.response.status_code'], 200);
  h.ctx.queue.drainNow();
});

test('base64 ids (protobuf JSON mapping) are normalised to hex', async () => {
  const trace = Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex').toString('base64');
  const body = otlpJson({ spans: [{ traceId: trace, spanId: Buffer.from('b7ad6b7169203331', 'hex').toString('base64'), name: 'x', startTimeUnixNano: ns(Date.now()), endTimeUnixNano: ns(Date.now() + 1) }] });
  assert.equal((await postRaw(JSON.stringify(body), { 'content-type': 'application/json' })).status, 200);
  assert.equal(queued()[0].trace_id, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(queued()[0].span_id, 'b7ad6b7169203331');
  h.ctx.queue.drainNow();
});

test('invalid spans give OTLP partial success, not an error', async () => {
  const body = otlpJson();
  delete body.resourceSpans[0].scopeSpans[0].spans[1].traceId;
  const r = await postRaw(JSON.stringify(body), { 'content-type': 'application/json' });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.partialSuccess.rejectedSpans, 1);
  assert.match(b.partialSuccess.errorMessage, /trace_id/);
  assert.equal(queued().length, 1);
  h.ctx.queue.drainNow();
});

test('protobuf partial success is protobuf-encoded', async () => {
  const enc = encodeExportTraceResponse({ rejectedSpans: 3, errorMessage: 'bad' });
  // field 1 (partial_success), length-delimited; inside: field 1 varint 3, field 2 "bad"
  assert.deepEqual([...enc], [0x0a, 0x07, 0x08, 0x03, 0x12, 0x03, 0x62, 0x61, 0x64]);
});

test('gzip-compressed protobuf is accepted (OTEL_EXPORTER_OTLP_COMPRESSION=gzip)', async () => {
  const r = await postRaw(zlib.gzipSync(FIXTURE), { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' });
  assert.equal(r.status, 200);
  assert.equal(queued().length, 2);
  h.ctx.queue.drainNow();
});

test('malformed protobuf -> 400; empty export -> 200; unknown fields are skipped', async () => {
  assert.equal((await postRaw(Buffer.from([0x0a, 0xff, 0x01]), { 'content-type': 'application/x-protobuf' })).status, 400);
  assert.equal((await postRaw(Buffer.alloc(0), { 'content-type': 'application/x-protobuf' })).status, 200);
  assert.equal((await postRaw('{"resourceSpans":[]}', { 'content-type': 'application/json' })).status, 200);
  // field 99 (unknown, varint) prepended to a valid message must be ignored
  const withUnknown = Buffer.concat([Buffer.from([0x98, 0x06, 0x01]), FIXTURE]);
  assert.equal(decodeExportTraceRequest(withUnknown).resourceSpans.length, 1);
});

test('oversized attribute sets are truncated and flagged, not rejected', async () => {
  const attrs = Array.from({ length: 100 }, (_, i) => ({ key: 'k' + i, value: { stringValue: 'v'.repeat(50) } }));
  const body = otlpJson({ spans: [{ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), name: 'big', startTimeUnixNano: ns(Date.now()), endTimeUnixNano: ns(Date.now() + 1), attributes: attrs }] });
  assert.equal((await postRaw(JSON.stringify(body), { 'content-type': 'application/json' })).status, 200);
  const s = queued()[0];
  assert.equal(Object.keys(s.attributes).length, 64);
  assert.equal(s.attributes_truncated, true);
  h.ctx.queue.drainNow();
});

test('/v1/metrics and /v1/logs are acknowledged but not stored', async () => {
  for (const p of ['/v1/metrics', '/v1/logs']) {
    const r = await fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: Buffer.from([1, 2, 3]) });
    assert.equal(r.status, 200);
  }
  assert.equal(h.ctx.metrics.c.ignored_signal_requests, 2);
});

test('end to end: OTLP spans from two services become one stored, complete trace', async () => {
  const hh = await harness({ config: { settle_window_ms: 200, batch_flush_interval_ms: 100 }, start: true });
  const u = await hh.listen();
  try {
    const traceId = 'ab'.repeat(16);
    const t0 = Date.now();
    const gateway = otlpJson({ traceId, service: 'gateway', spans: [
      { traceId, spanId: '1'.repeat(16), name: 'POST /pay', kind: 2, startTimeUnixNano: ns(t0), endTimeUnixNano: ns(t0 + 120), status: { code: 0 } },
      { traceId, spanId: '2'.repeat(16), parentSpanId: '1'.repeat(16), name: 'POST payments', kind: 3, startTimeUnixNano: ns(t0 + 10), endTimeUnixNano: ns(t0 + 100), status: { code: 0 } },
    ] });
    const payments = otlpJson({ traceId, service: 'payments', spans: [
      { traceId, spanId: '3'.repeat(16), parentSpanId: '2'.repeat(16), name: 'POST /charge', kind: 2, startTimeUnixNano: ns(t0 + 15), endTimeUnixNano: ns(t0 + 95),
        status: { code: 2, message: 'card declined' }, events: [{ timeUnixNano: ns(t0 + 90), name: 'exception', attributes: [{ key: 'exception.message', value: { stringValue: 'card declined' } }] }] },
    ] });
    for (const b of [payments, gateway]) {
      assert.equal((await fetch(u + '/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, 200);
    }
    let body;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const r = await fetch(u + '/v1/traces/' + traceId);
      body = await r.json();
      if (body.source === 'hot') break;
    }
    assert.equal(body.source, 'hot');
    const t = body.trace;
    assert.equal(t.span_count, 3);
    assert.equal(t.is_complete, true);
    assert.equal(t.status, 'ERROR');
    assert.equal(t.sample_reason, 'ERROR');
    assert.deepEqual(t.services, ['gateway', 'payments']);
    assert.equal(t.root_service, 'gateway');
    const charge = t.spans.find((s) => s.operation === 'POST /charge');
    assert.equal(charge.events[0].attributes['exception.message'], 'card declined');
    assert.equal(charge.kind, 'SERVER');
  } finally {
    await hh.cleanup();
  }
});
