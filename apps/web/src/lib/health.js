// Turn the collector's /metrics snapshot into six pipeline stages with a plain-language
// verdict each, mirroring the architecture: Receive → Queue → Assemble → Sample → Store → Archive.
import { ms, num, plural } from './format.js';

const delta = (cur, prev, pick) => (prev ? Math.max(0, pick(cur) - pick(prev)) : 0);

export function pipelineStages(m, prev) {
  if (!m) return [];
  const rejected = delta(m, prev, (x) => x.ingestion.rejected_spans);
  const invalid = delta(m, prev, (x) => x.ingestion.spans_invalid);
  const archiveFailed = delta(m, prev, (x) => x.archive.archive_failures);
  const rate = m.ingestion.ingest_rate_per_sec;
  const idle = rate === 0 && m.queue.queue_depth === 0;

  const receive = {
    key: 'receive', name: 'Receive', num: num(rate), unit: 'spans / s',
    state: rejected ? 'bad' : invalid ? 'warn' : idle ? 'idle' : 'ok',
    why: rejected ? `Turned away ${plural(rejected, 'span')} because the queue was full. Senders retry automatically.`
      : invalid ? `${plural(invalid, 'span')} had invalid data and were skipped.`
        : idle ? 'Waiting for spans from your services.' : 'Spans are arriving normally.',
  };

  const q = m.queue;
  const queue = {
    key: 'queue', name: 'Queue', num: num(q.queue_depth), unit: 'waiting',
    state: q.queue_state === 'FULL' ? 'bad' : q.queue_state === 'SOFT' ? 'warn' : idle ? 'idle' : 'ok',
    why: q.queue_state === 'FULL' ? 'Full. New spans are refused until it drains.'
      : q.queue_state === 'SOFT' ? 'Filling up. Keeping fewer normal traces to catch up; errors and slow requests are still kept.'
        : 'Keeping up with incoming spans.',
  };

  const a = m.aggregation;
  const assemble = {
    key: 'assemble', name: 'Assemble', num: num(a.open_traces), unit: 'open traces',
    state: idle && !a.open_traces ? 'idle' : 'ok',
    why: a.open_traces ? 'Waiting for every service to report before deciding.' : 'Grouping spans into traces by trace id.',
  };

  const s = m.sampling;
  const decided = s.kept_total + s.dropped_total;
  const keptPct = decided ? Math.round((s.kept_total / decided) * 100) : null;
  const sample = {
    key: 'sample', name: 'Sample', num: keptPct === null ? '–' : `${keptPct}%`, unit: 'of traces kept',
    state: decided ? (s.backpressure_adjusted_decisions && q.queue_state !== 'NORMAL' ? 'warn' : 'ok') : 'idle',
    why: decided ? `Kept ${num(s.kept_total)}, skipped ${num(s.dropped_total)} healthy ones. Errors and slow requests are always kept.`
      : 'No traces finished yet.',
  };

  const b = m.batching;
  const store = {
    key: 'store', name: 'Store', num: num(m.storage.hot_trace_count), unit: 'traces stored',
    state: b.breaker_state === 'open' ? 'bad' : b.breaker_state === 'half_open' || b.pending_batches > 2 ? 'warn' : 'ok',
    why: b.breaker_state === 'open' ? `Storage is unreachable. ${plural(b.pending_batches, 'batch', 'batches')} waiting safely; retrying automatically.`
      : b.breaker_state === 'half_open' ? 'Testing whether storage is back.'
        : b.pending_batches > 2 ? `${plural(b.pending_batches, 'batch', 'batches')} waiting to be written.`
          : `Saved in batches. Typical delay ${ms(m.storage.finalize_to_stored_ms.p50)}.`,
  };

  const ar = m.archive;
  const archive = {
    key: 'archive', name: 'Archive', num: num(ar.cold_trace_count ?? ar.archived_traces), unit: 'in cold storage',
    state: archiveFailed ? 'warn' : 'ok',
    why: archiveFailed ? 'Cold storage did not answer. Old traces stay in hot storage and the move is retried.'
      : 'Older traces move to cheap long-term storage.',
  };

  return [receive, queue, assemble, sample, store, archive];
}

/** One sentence for the top of the page: the worst problem, or a calm summary. */
export function headline(stages, m) {
  if (!m) return { state: 'idle', text: 'Connecting to the collector…', detail: '' };
  const bad = stages.find((s) => s.state === 'bad');
  if (bad) return { state: 'bad', text: `Needs attention: ${bad.name.toLowerCase()}`, detail: bad.why };
  const warn = stages.find((s) => s.state === 'warn');
  if (warn) return { state: 'warn', text: `Running, with a warning in ${warn.name.toLowerCase()}`, detail: warn.why };
  if (m.ingestion.ingest_rate_per_sec === 0) {
    return { state: 'idle', text: 'Healthy and waiting for traffic', detail: 'No spans in the last few seconds. Send some requests to your app, or start demo traffic.' };
  }
  return { state: 'ok', text: 'Healthy', detail: `Receiving ${num(m.ingestion.ingest_rate_per_sec)} spans a second. Every stage is keeping up.` };
}
