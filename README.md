# System_Design — Distributed Tracing & Telemetry Collector (Group 21)

An OpenTelemetry trace pipeline: **ingest → bounded queue → trace aggregation → tail-based
sampling → batched storage → cold archive**, with live config, metrics, health checks and
failure drills.

> Status: **Phase 0 (foundation)**. The collector engine works locally; OTLP ingest, the React
> dashboard, GitHub sign-in and cloud deployment arrive in Phases 1–5 (see `docs/architecture.md`).

## Repository layout

```
apps/
  collector/        Node 22 + Express 5 collector (the pipeline engine)
    src/            ingest, queue, aggregate, sample, batch, store, archive, control, metrics, query
    test/           node:test suites
    config/         default runtime config
    public/         legacy single-page dashboard (replaced by apps/web in Phase 1)
tools/
  loadgen/          Railway-reservation trace generator + end-to-end reconciliation check
docs/
  architecture.md   current architecture, known gaps, phase roadmap
  adr/              architecture decision records
  diagram/          architecture diagram
```

Planned (later phases): `apps/web` (React + Vite), `packages/shared`, `examples/demo-shop`.

## Quick start

Requires Node.js 20.4+ (22 recommended).

```bash
npm install
npm start                 # collector + legacy dashboard at http://localhost:4318
npm run loadgen           # 20 traces/s for 60 s
npm run loadgen:burst     # 15,000 spans as fast as possible
npm test                  # all workspace tests
npm run reset             # delete apps/collector/data and apps/collector/cold
npm run reconcile -- --duration 120 --wait 40 [--storage-outage]   # exact end-to-end check
```

Environment variables: see `.env.example`.

## Collector API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/traces` | Ingest spans (internal JSON format today; OTLP in Phase 1) |
| GET | `/v1/traces` | Search: `status, service, reason, min_duration_ms, from, to, limit, cursor, include_archived` |
| GET | `/v1/traces/:id` | One trace from hot store, in-flight, pending batch or cold archive |
| GET/PUT | `/v1/config` | Runtime config (PUT guarded by `X-Admin-Token` when `ADMIN_TOKEN` is set) |
| GET/PUT | `/v1/faults` | Failure drills: `storage_down`, `archive_down`, `slow_drain`, `ingest_delay_ms` |
| POST | `/v1/admin/flush`, `/v1/admin/archive/run` | Force a batch flush / archive run |
| GET | `/metrics`, `/health` | Pipeline metrics snapshot, health |

## Contributing

Branching, commit conventions and phase gates: see [`CONTRIBUTING.md`](CONTRIBUTING.md).
