'use strict';
// Minimal protobuf decoder for OTLP trace export requests (opentelemetry/proto v1).
// It produces the same object shape as OTLP/JSON (lowerCamelCase keys, hex ids,
// nanosecond timestamps as decimal strings), so one translator handles both encodings.
// Unknown fields are skipped, as protobuf requires.
//
// Field numbers (opentelemetry/proto/trace/v1/trace.proto, common/v1/common.proto):
//   ExportTraceServiceRequest  1 resource_spans
//   ResourceSpans              1 resource, 2 scope_spans, 3 schema_url
//   Resource                   1 attributes, 2 dropped_attributes_count
//   ScopeSpans                 1 scope, 2 spans, 3 schema_url
//   InstrumentationScope       1 name, 2 version, 3 attributes
//   Span 1 trace_id 2 span_id 3 trace_state 4 parent_span_id 5 name 6 kind
//        7 start_time_unix_nano(fixed64) 8 end_time_unix_nano(fixed64) 9 attributes
//        10 dropped_attributes_count 11 events 12 dropped_events_count 13 links
//        14 dropped_links_count 15 status 16 flags(fixed32)
//   Span.Event 1 time_unix_nano(fixed64) 2 name 3 attributes 4 dropped_attributes_count
//   Status     2 message 3 code
//   KeyValue   1 key 2 value
//   AnyValue   1 string 2 bool 3 int(int64) 4 double 5 array 6 kvlist 7 bytes
//   ArrayValue 1 values     KeyValueList 1 values

class ProtoError extends Error {}

class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  done() {
    return this.pos >= this.end;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new ProtoError('truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
    throw new ProtoError('varint too long');
  }

  fixed64() {
    if (this.pos + 8 > this.end) throw new ProtoError('truncated fixed64');
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }

  fixed32() {
    if (this.pos + 4 > this.end) throw new ProtoError('truncated fixed32');
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  double() {
    if (this.pos + 8 > this.end) throw new ProtoError('truncated double');
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  /** Returns a sub-reader over a length-delimited field. */
  sub() {
    const len = Number(this.varint());
    if (len < 0 || this.pos + len > this.end) throw new ProtoError('length out of range');
    const r = new Reader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }

  bytes() {
    const r = this.sub();
    return this.buf.subarray(r.pos, r.end);
  }

  string() {
    return this.bytes().toString('utf8');
  }

  tag() {
    const t = Number(this.varint());
    return { field: t >>> 3, wire: t & 7 };
  }

  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.sub();
    else if (wire === 5) this.pos += 4;
    else throw new ProtoError(`unsupported wire type ${wire}`);
    if (this.pos > this.end) throw new ProtoError('truncated field');
  }
}

/** Iterate fields of a message, calling handlers[field](reader, wire). */
function each(r, handlers) {
  while (!r.done()) {
    const { field, wire } = r.tag();
    const h = handlers[field];
    if (h) h(r, wire);
    else r.skip(wire);
  }
}

const toSigned64 = (u) => (u >= 1n << 63n ? u - (1n << 64n) : u);

function anyValue(r) {
  const out = {};
  each(r, {
    1: (x) => { out.stringValue = x.string(); },
    2: (x) => { out.boolValue = x.varint() !== 0n; },
    3: (x) => { out.intValue = toSigned64(x.varint()).toString(); },
    4: (x, w) => { if (w === 1) out.doubleValue = x.double(); else x.skip(w); },
    5: (x) => { const vals = []; each(x.sub(), { 1: (y) => vals.push(anyValue(y.sub())) }); out.arrayValue = { values: vals }; },
    6: (x) => { const vals = []; each(x.sub(), { 1: (y) => vals.push(keyValue(y.sub())) }); out.kvlistValue = { values: vals }; },
    7: (x) => { out.bytesValue = x.bytes().toString('base64'); },
  });
  return out;
}

function keyValue(r) {
  const kv = { key: '', value: {} };
  each(r, {
    1: (x) => { kv.key = x.string(); },
    2: (x) => { kv.value = anyValue(x.sub()); },
  });
  return kv;
}

function event(r) {
  const e = { timeUnixNano: '0', name: '', attributes: [] };
  each(r, {
    1: (x, w) => { if (w === 1) e.timeUnixNano = x.fixed64().toString(); else x.skip(w); },
    2: (x) => { e.name = x.string(); },
    3: (x) => { e.attributes.push(keyValue(x.sub())); },
  });
  return e;
}

function status(r) {
  const s = { code: 0 };
  each(r, {
    2: (x) => { s.message = x.string(); },
    3: (x) => { s.code = Number(x.varint()); },
  });
  return s;
}

function span(r) {
  const s = { attributes: [], events: [] };
  each(r, {
    1: (x) => { s.traceId = x.bytes().toString('hex'); },
    2: (x) => { s.spanId = x.bytes().toString('hex'); },
    3: (x) => { s.traceState = x.string(); },
    4: (x) => { const b = x.bytes(); if (b.length) s.parentSpanId = b.toString('hex'); },
    5: (x) => { s.name = x.string(); },
    6: (x) => { s.kind = Number(x.varint()); },
    7: (x, w) => { if (w === 1) s.startTimeUnixNano = x.fixed64().toString(); else x.skip(w); },
    8: (x, w) => { if (w === 1) s.endTimeUnixNano = x.fixed64().toString(); else x.skip(w); },
    9: (x) => { s.attributes.push(keyValue(x.sub())); },
    11: (x) => { s.events.push(event(x.sub())); },
    15: (x) => { s.status = status(x.sub()); },
  });
  return s;
}

function scopeSpans(r) {
  const ss = { scope: {}, spans: [] };
  each(r, {
    1: (x) => {
      const sc = {};
      each(x.sub(), { 1: (y) => { sc.name = y.string(); }, 2: (y) => { sc.version = y.string(); } });
      ss.scope = sc;
    },
    2: (x) => { ss.spans.push(span(x.sub())); },
  });
  return ss;
}

function resourceSpans(r) {
  const rs = { resource: { attributes: [] }, scopeSpans: [] };
  each(r, {
    1: (x) => { each(x.sub(), { 1: (y) => rs.resource.attributes.push(keyValue(y.sub())) }); },
    2: (x) => { rs.scopeSpans.push(scopeSpans(x.sub())); },
  });
  return rs;
}

/** Decode an ExportTraceServiceRequest. Throws ProtoError on malformed input. */
function decodeExportTraceRequest(buf) {
  const out = { resourceSpans: [] };
  each(new Reader(buf), { 1: (x) => out.resourceSpans.push(resourceSpans(x.sub())) });
  return out;
}

// ---- encoding (responses, and test fixtures) --------------------------------------------

function encVarint(n) {
  let v = BigInt(n);
  if (v < 0n) v += 1n << 64n;
  const bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}

const encTag = (field, wire) => encVarint((field << 3) | wire);
const encLen = (field, payload) => Buffer.concat([encTag(field, 2), encVarint(payload.length), payload]);
const encStr = (field, s) => encLen(field, Buffer.from(String(s), 'utf8'));
const encFixed64 = (field, n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return Buffer.concat([encTag(field, 1), b]); };
const encUint = (field, n) => Buffer.concat([encTag(field, 0), encVarint(n)]);

/** ExportTracePartialSuccess inside ExportTraceServiceResponse (field 1). */
function encodeExportTraceResponse({ rejectedSpans = 0, errorMessage = '' } = {}) {
  if (!rejectedSpans && !errorMessage) return Buffer.alloc(0);
  const ps = Buffer.concat([rejectedSpans ? encUint(1, rejectedSpans) : Buffer.alloc(0), errorMessage ? encStr(2, errorMessage) : Buffer.alloc(0)]);
  return encLen(1, ps);
}

module.exports = {
  decodeExportTraceRequest,
  encodeExportTraceResponse,
  ProtoError,
  // exported for tests / fixture builders
  enc: { varint: encVarint, tag: encTag, len: encLen, str: encStr, fixed64: encFixed64, uint: encUint },
};
