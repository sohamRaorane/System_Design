# Architecture

![The system as built](diagram/architecture-v2.svg)

The original design diagram is `diagram/architecture-v1.png`; its label errata are listed in
`diagram/README.md`.

## Product in one paragraph

A developer signs in with GitHub, picks a repository, and our GitHub App opens a pull request
that adds OpenTelemetry auto-instrumentation plus three environment variables. After merging and
deploying (anywhere), the app exports OTLP traces to our collector using a per-project ingest key.
The developer can then load-test their deployed URL from our UI and watch, in plain language, how
traces move through the pipeline and which ones the tail sampler kept and why.

## Pipeline (`apps/collector`)

```
POST /v1/traces → validate → SpanQueue (bounded; soft/hard limits, 429 + Retry-After)
  → Aggregator (group by trace_id, dedup by trace_id+span_id, timeout, tombstones)
  → Sampler (tail-based: ERROR 100%, HIGH_LATENCY 100%, INCOMPLETE kept, NORMAL ~10%;
             normal rate × backpressure factor when the queue is not NORMAL)
  → BatchProcessor (size/interval flush, in-order single writer, backoff, circuit breaker,
                    shed NORMAL first then spill to disk under long outages)
  → TraceRepo (SQLite WAL, merge-on-write, cursor-paged search)
  → ArchiveWorker (gzip day-folders, write-then-index-then-delete, cold retention purge)
Control plane: RuntimeConfig (validated, versioned, hot-reload), faults, /metrics, /health.
```

## Known gaps and the phase that closes each

| # | Gap | Phase |
|---|---|---|
| G1 | ~~`/v1/traces` accepts our own flat JSON, not OTLP~~ — closed: OTLP protobuf + JSON | 1 ✔ |
| G2 | ~~Real traces finalized after 500 ms; later services' spans dropped as late~~ — closed: 6 s settle window, late spans merged into kept traces | 1 ✔ |
| G3 | ~~No users, projects or tenant isolation~~: closed by GitHub sign-in, projects, ingest keys, per-project storage keys | 2 ✔ |
| G4 | ~~Control endpoints open when `ADMIN_TOKEN` is unset~~: closed; production refuses to start without it | 2 ✔ |
| G5 | ~~Data on Render's ephemeral disk~~: closed; Postgres (Neon) for data, R2 for the archive. Spill files during a long database outage still use local disk (lost on restart). | 5 ✔ |
| G6 | ~~Collector cannot run on Vercel~~: closed; collector on Render, dashboard on Vercel with an /api rewrite | 5 ✔ |
| G7 | Aggregator state is in-memory, so only one instance is correct | documented; trace-id routing after v1.0 |
| G8 | ~~Archived search by root service only; sync gunzip~~ — closed in the async storage refactor | 1 ✔ |

## Deployment target (v1.0)

```
Browser ──► Vercel (apps/web, React+Vite) ──/api/* rewrite──► Render Free (apps/collector)
User apps ──OTLP/HTTP + ingest key──────────────────────────► Render Free (apps/collector)
apps/collector ──► Neon Postgres (users, projects, keys, hot traces)
               ──► Cloudflare R2 (cold archive, spill)
               ──► GitHub (OAuth sign-in, GitHub App PRs)
```

See `docs/adr/` for the reasoning behind each choice.

## Phase roadmap

| Phase | Goal | Gate demo |
|---|---|---|
| 0 | Monorepo, CI, docs | Repo on GitHub, CI green |
| 1 | OTLP ingest, late-span fix, demo-shop, React trace list + waterfall | Real OTel spans → one complete waterfall |
| 2 | GitHub sign-in, JWT/JWKS, projects, ingest keys, tenant isolation | Two users see only their own traces |
| 3 | Connect repo: stack detection, snippet, GitHub App PR, first-trace check | Merge PR → wizard turns green |
| 4 | Verified load testing + demo traffic | 60 s test → live charts + kept traces |
| 5 | Postgres, R2, Render + Vercel deploy | Full flow on public URLs |
| 6 | Rate limits, retention, async cold reads, self-metrics, Playwright, failure drills | All 8 drills pass in cloud |
| 7 | Plain-language UI, theme switch, phone layout, corrected diagram, docs | Tag v1.0.0 |
