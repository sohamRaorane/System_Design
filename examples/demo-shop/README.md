# demo-shop

Three tiny services that call each other — **gateway → orders → payments** — instrumented
with the official OpenTelemetry zero-code package (`@opentelemetry/auto-instrumentations-node`).
No tracing code is written by hand except two optional helpers (`annotate`, `recordError`).
It is the "user's app" used to prove the pipeline end to end.

```
npm install
# local collector on :4318 (npm start at the repo root), then:
npm start                                  # gateway on http://localhost:3000
npm run traffic -- http://localhost:3000 3 60   # 3 checkouts/s for 60 s
```

Every checkout produces one trace with spans from `demo-gateway`, `demo-orders` and
`demo-payments`. By default 10 % of payments fail (ERROR traces, always kept by the tail
sampler) and 5 % are slow (2.5 s, kept as HIGH_LATENCY). Force either with
`POST /api/checkout?fail=1` or `?slow=1`.

| Variable | Purpose |
|---|---|
| `PORT` | gateway port (default 3000) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | collector base URL (default `http://localhost:4318`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `x-api-key=<project ingest key>` once projects exist |
| `OTEL_PIPELINE_VERIFY_TOKEN` | served at `/.well-known/otel-pipeline.txt` to prove ownership for load tests |
| `DEMO_FAIL_PCT`, `DEMO_SLOW_PCT`, `DEMO_SLOW_MS` | failure / slowness knobs |

Without `npm install` the shop still runs, just without tracing.
