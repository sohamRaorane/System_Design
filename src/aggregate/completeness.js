'use strict';
// Completeness rules (section 5.4).
//  - No root span            -> never complete.
//  - Root has a hint         -> complete when span_count >= trace.expected_spans (settle window unused).
//  - Root without a hint     -> structurally complete when no span references a missing parent;
//                               the aggregator then waits settle_window_ms of quiet before finalizing.

const HINT_KEY = 'trace.expected_spans';

function readHint(rootSpan) {
  const v = rootSpan?.attributes?.[HINT_KEY];
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** @returns {'hint'|'structure'|'none'} */
function evaluate(entry) {
  if (!entry.rootSpanId) return 'none';
  if (entry.expectedSpans) return entry.spans.size >= entry.expectedSpans ? 'hint' : 'none';
  for (const span of entry.spans.values()) {
    if (span.parent_span_id && !entry.spans.has(span.parent_span_id)) return 'none';
  }
  return 'structure';
}

module.exports = { evaluate, readHint, HINT_KEY };
