# OpenTelemetry tracing

This repository sends traces to **Tracepipe**, an OpenTelemetry pipeline with tail-based
sampling: failed and slow requests are always kept, healthy ones are sampled.

## What this pull request changed

- `package.json`: adds the OpenTelemetry packages
- `OPENTELEMETRY.md`: this guide

The `@opentelemetry/auto-instrumentations-node` package traces HTTP servers and clients, Express, databases and more without code changes. It is loaded before your app with `--require @opentelemetry/auto-instrumentations-node/register`.

## What you still need to do

Set these environment variables where the app runs (Render, Vercel, Docker, your shell).
Get the ingest key from the project's **Settings** page in the dashboard. Never commit it.

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://tracepipe-collector.onrender.com
OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<your ingest key from the dashboard>
OTEL_SERVICE_NAME=system_design
OTEL_TRACES_EXPORTER=otlp
OTEL_METRICS_EXPORTER=none
OTEL_LOGS_EXPORTER=none
```

Then deploy. Traces appear in the dashboard a few seconds after the first request.

## Notes

- Your start script ("npm run start -w @system-design/collector") is not a plain `node <file>` command, so it was left unchanged. Set NODE_OPTIONS=--require @opentelemetry/auto-instrumentations-node/register where the app runs instead.
- Run `npm install` (or your package manager) so the lockfile picks up the new packages.

## Turning it off

Set `OTEL_SDK_DISABLED=true`, or revert this pull request.
