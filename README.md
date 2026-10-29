# System_Design — Distributed Tracing & Telemetry Collector (Group 21)

An OpenTelemetry trace pipeline: **ingest → bounded queue → trace aggregation → tail-based
sampling → batched storage → cold archive**, with live config, metrics, health checks and
failure drills.

> Status: **Phase 1 (walking skeleton)**. Real OpenTelemetry SDKs export to the collector over
> OTLP/HTTP (protobuf or JSON); the React dashboard shows the pipeline and the traces.

## Repository layout

```
apps/
  collector/        Node 22 + Express 5 collector (the pipeline engine)
    src/            ingest, queue, aggregate, sample, batch, store, archive, control, metrics, query
    test/           node:test suites
    config/         default runtime config
  web/              React + Vite dashboard
examples/
  demo-shop/        3 services instrumented with OpenTelemetry zero-code (the "user app")
tools/
  loadgen/          Railway-reservation trace generator + end-to-end reconciliation check
docs/
  architecture.md   current architecture, known gaps, phase roadmap
  adr/              architecture decision records
  diagram/          architecture diagram
```


## Quick start

Requires Node.js 22.13 or newer (the collector uses the built-in `node:sqlite`; no native build step).

```bash
npm install
npm start                 # collector on http://localhost:4318
npm run dev:web           # dashboard on http://localhost:5173 (proxies to the collector)
npm run loadgen           # 20 traces/s for 60 s
npm run loadgen:burst     # 15,000 spans as fast as possible
npm test                  # all workspace tests
npm run reset             # delete apps/collector/data and apps/collector/cold
npm run reconcile -- --duration 120 --wait 40 [--storage-outage]   # exact end-to-end check
```

See it work with a real OpenTelemetry app:

```bash
cd examples/demo-shop && npm install && npm start        # 3 instrumented services on :3000
npm run traffic -- http://localhost:3000 3 60             # checkouts for 60 s
```

Open the dashboard: each checkout is one trace across `demo-gateway`, `demo-orders` and
`demo-payments`; failed and slow payments are always kept.

Environment variables: see `.env.example`.

## Collector API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/traces` | Ingest: OTLP/HTTP protobuf, OTLP/JSON, or the legacy flat JSON |
| POST | `/v1/metrics`, `/v1/logs` | Acknowledged, not stored (traces only in v1.0) |
| GET | `/v1/traces` | Search: `status, service, reason, min_duration_ms, from, to, limit, cursor, include_archived` |
| GET | `/v1/traces/:id` | One trace from hot store, in-flight, pending batch or cold archive |
| GET/PUT | `/v1/config` | Runtime config (PUT guarded by `X-Admin-Token` when `ADMIN_TOKEN` is set) |
| GET/PUT | `/v1/faults` | Failure drills: `storage_down`, `archive_down`, `slow_drain`, `ingest_delay_ms` |
| POST | `/v1/admin/flush`, `/v1/admin/archive/run` | Force a batch flush / archive run |
| GET | `/metrics`, `/health` | Pipeline metrics snapshot, health |

## Contributing

Branching, commit conventions and phase gates: see [`CONTRIBUTING.md`](CONTRIBUTING.md).
