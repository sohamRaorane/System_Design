# Failure scenarios and how each is handled

The architecture diagram lists eight failure scenarios (section 7). This table shows, for each
one, the mechanism that handles it, the automated test that proves it, and how to watch it
live.

| # | Scenario | Mechanism | Proven by (apps/collector/test) | Watch it live |
|---|---|---|---|---|
| 1 | **Collector crash** | Every stored trace is committed before it counts as stored; on SIGTERM the queue is drained, open traces are finalized and batches flushed (25 s budget, under Render's 30 s) | `lifecycle` T17 (graceful), T18 (SIGKILL + restart: all stored traces survive) | Restart the Render service during demo traffic |
| 2 | **Network partition** (app ↔ collector) | Senders keep spans and retry with backoff; 429 carries `Retry-After`; OTel SDKs do the same | `lifecycle` T20 (load generator holds spans until the collector returns) | Stop the collector for a minute while the demo shop sends traffic |
| 3 | **Storage unavailable** | Batches stay in an ordered in-memory queue, retries back off, the circuit breaker pauses writes after 3 failures; under long outages healthy traces are shed first, then batches spill to disk; everything is replayed on recovery | `storage` T11, T12 | Admin, **Storage goes down** |
| 4 | **Queue overload** | Bounded queue: past the soft limit the healthy-trace sampling rate is multiplied by `backpressure_sampling_factor` (errors and slow traces are still kept); at the hard limit requests get 429 + Retry-After and nothing is half-accepted; per-project rate limits stop one app starving others | `ingest` T2, `sampler_config` T8 (backpressure), `ratelimit` | Admin, **Collector falls behind**, plus simulated traffic |
| 5 | **Incomplete trace** | Each trace has a timeout; when it fires the trace is finalized as incomplete and kept (configurable). Late spans of kept traces are merged in later; late ERROR spans are never dropped | `aggregation` T4, G2 tests | Simulated traffic includes traces whose root never arrives; filter Traces by **Incomplete** |
| 6 | **Duplicate spans** | Dedup on (trace id, span id) while assembling, tombstones after finalizing, merge-on-write in storage (a re-sent batch changes nothing) | `aggregation` T6, `storage` T13 | Send the same OTLP request twice: the counters show duplicates, the trace is unchanged |
| 7 | **Indexing failure** | One transaction per batch: a failure rolls the whole batch back and it is retried whole; any storage exception (disk full, read-only) counts as a failure | `storage` T11 mid-batch, E43 | Admin, **Storage goes down** |
| 8 | **Archive upload failure** | Upload first, then index + delete hot rows in one transaction; if the upload fails, traces stay hot and the run retries with backoff; a crash between upload and index leaves a harmless orphan object | `query_archive` T15, T16, `blob` (R2 outage) | Admin, **Archive storage fails**, then **Run the archive now** |

## End-to-end reconciliation

`npm run reconcile -- --duration 120 --wait 40 [--storage-outage]` sends a seeded, known mix
of traffic and compares every counter the collector reports with the exact expected values,
optionally with a 30-second storage outage in the middle. Use `--key otk_...` (or
`INGEST_KEY`) against a deployed collector.
