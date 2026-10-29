'use strict';
// Builds the Trace record of section 4.2 from a set of spans.
// Shared by the aggregator (finalize) and the repository (merge-on-write, E46).

function sortSpans(spans) {
  return [...spans].sort((a, b) => a.start_time - b.start_time || (a.span_id < b.span_id ? -1 : a.span_id > b.span_id ? 1 : 0));
}

/** Pick the root: the given rootSpanId, else the earliest parentless span, else the earliest span. */
function pickRoot(sorted, rootSpanId) {
  if (rootSpanId) {
    const r = sorted.find((s) => s.span_id === rootSpanId);
    if (r) return r;
  }
  return sorted.find((s) => !s.parent_span_id) || sorted[0] || null;
}

/**
 * @param {object[]} spans
 * @param {object} meta { trace_id, rootSpanId, is_complete, created_at, finalized_at, truncated }
 */
function buildTrace(spans, meta) {
  const sorted = sortSpans(spans);
  const root = pickRoot(sorted, meta.rootSpanId);
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let error = false;
  const services = new Set();
  for (const s of sorted) {
    if (s.start_time < minStart) minStart = s.start_time;
    if (s.end_time > maxEnd) maxEnd = s.end_time;
    if (s.status === 'ERROR') error = true;
    services.add(s.service);
  }
  return {
    trace_id: meta.trace_id,
    spans: sorted,
    root_service: root ? root.service : null,
    root_operation: root ? root.operation : null,
    status: error ? 'ERROR' : 'OK',
    duration_ms: sorted.length ? maxEnd - minStart : 0,
    span_count: sorted.length,
    services: [...services].sort(),
    is_complete: Boolean(meta.is_complete),
    truncated: Boolean(meta.truncated),
    sampled: false,
    sample_reason: null,
    created_at: meta.created_at,
    finalized_at: meta.finalized_at,
    stored_at: null,
  };
}

module.exports = { buildTrace, sortSpans };
