'use strict';
// Translate an OTLP ExportTraceServiceRequest (JSON shape; protobuf is decoded into the
// same shape first) into the collector's internal span records.
//
// Real-world data is accepted leniently: attribute sets that exceed our limits are
// truncated (and flagged) rather than rejected, because an SDK cannot fix them.

const MAX_ATTR_KEYS = 64;
const MAX_ATTR_VALUE = 1024;
const MAX_ATTR_BYTES = 8 * 1024;
const MAX_EVENTS = 32;
const MAX_EVENT_ATTR_KEYS = 16;

const KINDS = ['UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];
const STATUS = ['UNSET', 'OK', 'ERROR'];
// Resource attributes worth keeping on every span (everything else stays out of storage).
const RESOURCE_KEYS = ['service.version', 'service.namespace', 'deployment.environment', 'deployment.environment.name', 'host.name', 'telemetry.sdk.language', 'telemetry.sdk.name'];

const HEX = /^[0-9a-f]+$/i;

/**
 * OTLP/JSON ids are hex. Some exporters send base64 (the raw protobuf JSON mapping);
 * convert those so ids from every SDK line up.
 */
function normalizeOtlpId(v, bytes) {
  if (typeof v !== 'string' || !v) return null;
  if (v.length === bytes * 2 && HEX.test(v)) return v.toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v)) {
    const b = Buffer.from(v, 'base64');
    if (b.length === bytes) return b.toString('hex');
  }
  return v;
}

function nanosToMs(v) {
  if (v === undefined || v === null || v === '') return null;
  try {
    const n = typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
    return n;
  } catch {
    return null;
  }
}

function enumValue(v, names, prefix) {
  if (typeof v === 'number') return names[v] ?? names[0];
  if (typeof v === 'string') {
    const s = v.toUpperCase().replace(prefix, '');
    return names.includes(s) ? s : names[0];
  }
  return names[0];
}

/** AnyValue -> a flat primitive (arrays and maps become compact JSON strings). */
function anyToPrimitive(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return String(v.stringValue);
  if ('boolValue' in v) return Boolean(v.boolValue);
  if ('intValue' in v) {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : String(v.intValue);
  }
  if ('doubleValue' in v) {
    const n = Number(v.doubleValue);
    return Number.isFinite(n) ? n : String(v.doubleValue);
  }
  if ('arrayValue' in v) return JSON.stringify((v.arrayValue?.values || []).map(anyToPrimitive));
  if ('kvlistValue' in v) return JSON.stringify(flattenAttributes(v.kvlistValue?.values || [], { limitKeys: 32 }).attributes);
  if ('bytesValue' in v) return String(v.bytesValue);
  return null;
}

/** KeyValue[] -> { attributes, truncated } within our storage limits. */
function flattenAttributes(list, { limitKeys = MAX_ATTR_KEYS } = {}) {
  const out = {};
  let truncated = false;
  let bytes = 2;
  if (!Array.isArray(list)) return { attributes: out, truncated };
  for (const kv of list) {
    if (!kv || typeof kv.key !== 'string' || !kv.key) continue;
    if (Object.keys(out).length >= limitKeys) { truncated = true; break; }
    let val = anyToPrimitive(kv.value);
    if (val === null) continue;
    if (typeof val === 'string' && val.length > MAX_ATTR_VALUE) { val = val.slice(0, MAX_ATTR_VALUE) + '…'; truncated = true; }
    const size = Buffer.byteLength(JSON.stringify(kv.key)) + Buffer.byteLength(JSON.stringify(val)) + 2;
    if (bytes + size > MAX_ATTR_BYTES) { truncated = true; continue; }
    bytes += size;
    out[kv.key] = val;
  }
  return { attributes: out, truncated };
}

/**
 * @param {object} req ExportTraceServiceRequest in JSON shape
 * @returns {{ spans: object[], total: number }} raw internal spans (not yet validated)
 */
function translateOtlp(req) {
  const spans = [];
  let total = 0;
  for (const rs of Array.isArray(req?.resourceSpans) ? req.resourceSpans : []) {
    const res = flattenAttributes(rs?.resource?.attributes, { limitKeys: 128 }).attributes;
    const service = typeof res['service.name'] === 'string' && res['service.name'].trim() ? res['service.name'] : 'unknown_service';
    const resource = {};
    for (const k of RESOURCE_KEYS) if (res[k] !== undefined) resource[k] = res[k];
    for (const ss of Array.isArray(rs?.scopeSpans) ? rs.scopeSpans : []) {
      const scope = ss?.scope?.name || undefined;
      for (const s of Array.isArray(ss?.spans) ? ss.spans : []) {
        total++;
        const start = nanosToMs(s?.startTimeUnixNano);
        const end = nanosToMs(s?.endTimeUnixNano);
        const { attributes, truncated } = flattenAttributes(s?.attributes);
        const events = (Array.isArray(s?.events) ? s.events : []).slice(0, MAX_EVENTS).map((e) => {
          const t = nanosToMs(e?.timeUnixNano);
          return {
            name: String(e?.name || 'event').slice(0, 128),
            time: t === null ? null : Number(t / 1_000_000n),
            attributes: flattenAttributes(e?.attributes, { limitKeys: MAX_EVENT_ATTR_KEYS }).attributes,
          };
        });
        const statusCode = enumValue(s?.status?.code, STATUS, 'STATUS_CODE_');
        const span = {
          trace_id: normalizeOtlpId(s?.traceId, 16),
          span_id: normalizeOtlpId(s?.spanId, 8),
          parent_span_id: normalizeOtlpId(s?.parentSpanId, 8),
          service,
          operation: typeof s?.name === 'string' ? s.name.slice(0, 128) : s?.name,
          start_time: start === null ? null : Number(start / 1_000_000n),
          end_time: end === null ? null : Number(end / 1_000_000n),
          duration_us: start !== null && end !== null && end >= start ? Number((end - start) / 1000n) : undefined,
          status: statusCode,
          status_message: s?.status?.message ? String(s.status.message).slice(0, 512) : undefined,
          kind: enumValue(s?.kind, KINDS, 'SPAN_KIND_'),
          attributes,
          events: events.length ? events : undefined,
          resource: Object.keys(resource).length ? resource : undefined,
          scope,
        };
        if (truncated) span.attributes_truncated = true;
        spans.push(span);
      }
    }
  }
  return { spans, total };
}

const isOtlpJson = (body) => body !== null && typeof body === 'object' && !Array.isArray(body) && Array.isArray(body.resourceSpans);

module.exports = { translateOtlp, isOtlpJson, flattenAttributes, normalizeOtlpId };
