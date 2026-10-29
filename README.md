# Telemetry Collector (Group 21)

Single-process Node.js collector: ingest spans → queue → trace aggregation → tail sampling → batched SQLite → gzip cold archive, with config, metrics, health and a dashboard. Port **4318**.

```
npm install
npm start                 # collector + dashboard at http://localhost:4318
npm run loadgen           # 20 traces/s for 60 s (Railway booking traces)
npm run loadgen:burst     # 15,000 spans as fast as possible (use with the slow_drain fault)
npm test                  # 54 tests across 20 suites (T1-T20)
npm run reset             # delete data/ and cold/
node scripts/reconcile.js --duration 120 --wait 40 [--storage-outage]   # exact end-to-end check (9.3)
```

Env: `PORT`, `DB_PATH`, `COLD_DIR`, `CONFIG_PATH`, `LOG_LEVEL`, `ADMIN_TOKEN` (guards PUT/POST control endpoints via `X-Admin-Token`).

API: `POST /v1/traces`, `GET /v1/traces[?status&service&reason&min_duration_ms&from&to&limit&cursor&include_archived]`, `GET /v1/traces/:id`,
`GET|PUT /v1/config`, `GET|PUT /v1/faults`, `POST /v1/admin/flush`, `POST /v1/admin/archive/run`, `GET /metrics`, `GET /health`.

Demo tip: set `hot_retention_days` to `0.001` and `archive_interval_ms` to `20000` (config editor or `config/default.json`) to watch archival live.
Fault switches: `storage_down`, `archive_down`, `slow_drain`, `ingest_delay_ms`.
