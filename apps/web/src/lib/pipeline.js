// Live collector metrics, shared by every page. One poller feeds all subscribers and keeps a
// short in-browser history so the dashboard can draw real time-series without inventing data.
// History starts when the first subscriber mounts; it is not a server-side retention store.
import { useEffect, useState } from 'react';
import { api } from './api.js';

const POLL_MS = 2000;
const MAX_POINTS = 450; // 15 minutes at one sample every two seconds

let state = { data: null, prev: null, error: null, loading: true, history: [], lastUpdated: null };
const subscribers = new Set();
let timer = null;
let inFlight = null;

function sample(data, at) {
  return {
    t: at,
    ingestRate: data?.ingestion?.ingest_rate_per_sec ?? 0,
    queueDepth: data?.queue?.queue_depth ?? 0,
    queueState: data?.queue?.queue_state ?? 'NORMAL',
    openTraces: data?.aggregation?.open_traces ?? 0,
    pendingBatches: data?.batching?.pending_batches ?? 0,
    storageP50: data?.storage?.finalize_to_stored_ms?.p50 ?? null,
    storageP95: data?.storage?.finalize_to_stored_ms?.p95 ?? null,
    memoryRss: data?.process?.rss_mb ?? data?.memory_rss_mb ?? null,
    loopP99: data?.process?.event_loop_delay_ms?.p99 ?? null,
    kept: data?.sampling?.kept_total ?? 0,
    dropped: data?.sampling?.dropped_total ?? 0,
    spansReceived: data?.ingestion?.spans_received ?? 0,
    rejected: data?.ingestion?.rejected_spans ?? 0,
    archived: data?.archive?.archived_traces ?? 0,
    breaker: data?.batching?.breaker_state ?? 'closed',
    hot: data?.storage?.hot_trace_count ?? null,
    cold: data?.archive?.cold_trace_count ?? null,
  };
}

function emit() {
  for (const fn of subscribers) fn(state);
}

async function poll() {
  if (inFlight) return inFlight;
  inFlight = api.pipeline()
    .then((data) => {
      const at = Date.now();
      state = {
        data,
        prev: state.data,
        error: null,
        loading: false,
        lastUpdated: at,
        history: [...state.history, sample(data, at)].slice(-MAX_POINTS),
      };
    })
    .catch((error) => {
      state = { ...state, loading: false, error };
    })
    .finally(() => {
      inFlight = null;
      emit();
    });
  return inFlight;
}

function ensurePolling() {
  if (!state.data && !state.error) poll();
  if (timer !== null) return;
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') poll();
  }, POLL_MS);
}

function releasePolling() {
  if (subscribers.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export function usePipeline() {
  const [snapshot, setSnapshot] = useState(state);
  useEffect(() => {
    subscribers.add(setSnapshot);
    ensurePolling();
    setSnapshot(state);
    return () => {
      subscribers.delete(setSnapshot);
      releasePolling();
    };
  }, []);
  return { ...snapshot, refresh: poll };
}

/** Keep only the samples inside a time range (used by the range selector). */
export function withinRange(history, rangeMs) {
  if (!rangeMs) return history;
  const cutoff = Date.now() - rangeMs;
  return history.filter((p) => p.t >= cutoff);
}

export const RANGES = [
  { key: '1m', label: '1m', ms: 60_000 },
  { key: '5m', label: '5m', ms: 300_000 },
  { key: '15m', label: '15m', ms: 900_000 },
];

// Metrics that are actually sampled into the in-browser history. The explorer never pretends to
// query a time-series database; it plots what this dashboard has observed since it was opened.
export const METRIC_CATALOG = [
  { key: 'ingestRate', group: 'Throughput', label: 'Ingest rate', unit: 'spans/s', pick: (h) => h.ingestRate, description: 'Rolling five-second average of spans accepted by the ingestion endpoint.' },
  { key: 'spansReceived', group: 'Throughput', label: 'Spans received (total)', unit: 'spans', pick: (h) => h.spansReceived, description: 'Cumulative spans received since the collector started.' },
  { key: 'rejected', group: 'Throughput', label: 'Rejected spans (total)', unit: 'spans', pick: (h) => h.rejected, description: 'Spans refused because the queue was at its hard limit. Senders retry.' },
  { key: 'queueDepth', group: 'Saturation', label: 'Queue depth', unit: 'spans', pick: (h) => h.queueDepth, description: 'Spans waiting in the bounded in-memory queue.' },
  { key: 'openTraces', group: 'Saturation', label: 'Open traces', unit: 'traces', pick: (h) => h.openTraces, description: 'Traces currently being assembled from spans across services.' },
  { key: 'pendingBatches', group: 'Saturation', label: 'Pending write batches', unit: 'batches', pick: (h) => h.pendingBatches, description: 'Batches waiting for the database writer; grows during a storage outage.' },
  { key: 'storageP50', group: 'Latency', label: 'Store latency p50', unit: 'ms', pick: (h) => h.storageP50, description: 'Median delay from trace finalization to a successful database write.' },
  { key: 'storageP95', group: 'Latency', label: 'Store latency p95', unit: 'ms', pick: (h) => h.storageP95, description: '95th-percentile delay from finalization to a successful database write.' },
  { key: 'loopP99', group: 'Resources', label: 'Event loop delay p99', unit: 'ms', pick: (h) => h.loopP99, description: '99th-percentile collector event-loop delay; a saturation signal for Node.js.' },
  { key: 'memoryRss', group: 'Resources', label: 'Resident memory', unit: 'MB', pick: (h) => h.memoryRss, description: 'Resident set size of the collector process.' },
  { key: 'kept', group: 'Sampling', label: 'Traces kept (total)', unit: 'traces', pick: (h) => h.kept, description: 'Cumulative traces kept by tail-based sampling.' },
  { key: 'dropped', group: 'Sampling', label: 'Healthy traces skipped (total)', unit: 'traces', pick: (h) => h.dropped, description: 'Cumulative healthy traces deliberately skipped by sampling.' },
  { key: 'archived', group: 'Storage', label: 'Archived traces (total)', unit: 'traces', pick: (h) => h.archived, description: 'Cumulative traces moved from hot storage to the cold archive.' },
  { key: 'hot', group: 'Storage', label: 'Hot traces', unit: 'traces', pick: (h) => h.hot, description: 'Traces currently searchable in the hot database.' },
  { key: 'cold', group: 'Storage', label: 'Cold traces', unit: 'traces', pick: (h) => h.cold, description: 'Traces indexed in cold object storage.' },
];
