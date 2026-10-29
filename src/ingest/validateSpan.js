'use strict';
// Span schema checks and normalisation (section 4.1).
const { ID_PATTERN, normalizeId } = require('../util/common');

const STATUSES = new Set(['OK', 'ERROR', 'UNSET']);
const MAX_NAME = 128;
const MAX_ATTR_KEYS = 64;
const MAX_ATTR_BYTES = 8 * 1024;
const FUTURE_SKEW_MS = 60 * 60 * 1000;
const PAST_SKEW_MS = 24 * 60 * 60 * 1000;

function checkId(value, field, errors) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    errors.push({ field, reason: 'must match ^[A-Za-z0-9_-]{1,64}$ (32/16 hex chars recommended)' });
    return null;
  }
  return normalizeId(value);
}

function checkName(value, field, errors) {
  if (typeof value !== 'string') {
    errors.push({ field, reason: 'must be a string' });
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) errors.push({ field, reason: 'must not be empty' });
  else if (trimmed.length > MAX_NAME) errors.push({ field, reason: `max ${MAX_NAME} chars` });
  return trimmed;
}

/**
 * Validate one raw span.
 * @returns {{ span, skewed: boolean } | { errors: Array<{field, reason}> }}
 */
function validateSpan(raw, nowMs = Date.now()) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { errors: [{ field: '(span)', reason: 'must be an object' }] };
  }

  const trace_id = checkId(raw.trace_id, 'trace_id', errors);
  const span_id = checkId(raw.span_id, 'span_id', errors);

  let parent_span_id = null;
  if (raw.parent_span_id !== undefined && raw.parent_span_id !== null && raw.parent_span_id !== '') {
    parent_span_id = checkId(raw.parent_span_id, 'parent_span_id', errors);
    if (parent_span_id && span_id && parent_span_id === span_id) {
      errors.push({ field: 'parent_span_id', reason: 'must not equal span_id' });
    }
  }

  const serviceRaw = checkName(raw.service, 'service', errors);
  const service = serviceRaw ? serviceRaw.toLowerCase() : serviceRaw;
  const operation = checkName(raw.operation, 'operation', errors);

  const { start_time, end_time } = raw;
  if (!Number.isInteger(start_time) || start_time < 0) {
    errors.push({ field: 'start_time', reason: 'must be integer epoch milliseconds' });
  }
  if (!Number.isInteger(end_time) || end_time < 0) {
    errors.push({ field: 'end_time', reason: 'must be integer epoch milliseconds' });
  } else if (Number.isInteger(start_time) && end_time < start_time) {
    errors.push({ field: 'end_time', reason: 'must be >= start_time' });
  }

  let status = 'UNSET';
  if (raw.status !== undefined && raw.status !== null) {
    if (typeof raw.status !== 'string' || !STATUSES.has(raw.status.toUpperCase())) {
      errors.push({ field: 'status', reason: 'must be OK, ERROR or UNSET' });
    } else {
      status = raw.status.toUpperCase();
    }
  }

  let attributes = {};
  if (raw.attributes !== undefined && raw.attributes !== null) {
    const a = raw.attributes;
    if (typeof a !== 'object' || Array.isArray(a)) {
      errors.push({ field: 'attributes', reason: 'must be a flat object' });
    } else {
      const keys = Object.keys(a);
      if (keys.length > MAX_ATTR_KEYS) {
        errors.push({ field: 'attributes', reason: `max ${MAX_ATTR_KEYS} keys` });
      }
      for (const k of keys) {
        const v = a[k];
        const ok = typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
        if (!ok) {
          errors.push({ field: `attributes.${k}`, reason: 'value must be string, number or boolean' });
          break;
        }
      }
      if (Buffer.byteLength(JSON.stringify(a)) > MAX_ATTR_BYTES) {
        errors.push({ field: 'attributes', reason: 'serialized size max 8 KB' });
      }
      attributes = a;
    }
  }

  if (errors.length) return { errors };

  const skewed = start_time > nowMs + FUTURE_SKEW_MS || start_time < nowMs - PAST_SKEW_MS;
  return {
    span: { trace_id, span_id, parent_span_id, service, operation, start_time, end_time, status, attributes },
    skewed,
  };
}

module.exports = { validateSpan };
