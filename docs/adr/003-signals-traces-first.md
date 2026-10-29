# ADR-003: v1.0 signal scope — traces, with errors as span events

- Status: Accepted (2026-10-29)

## Decision
- v1.0 ingests **OTLP traces** (HTTP, JSON and protobuf) only.
- Span **events** are kept, so recorded exceptions (`exception.type`, `exception.message`,
  `exception.stacktrace`) appear inside the trace waterfall. This gives DevOps the "log line at
  the moment of failure" without a separate log pipeline.
- Span kind, status message and resource attributes (`service.name`, `service.version`,
  `deployment.environment`) are kept.
- OTLP logs and metrics are out of scope for v1.0; the ingest layer is structured so
  `/v1/logs` can be added later without touching the trace pipeline.

## Why
The architecture (aggregation, tail sampling, batching, archive) is trace-specific. Adding logs
and metrics would double the scope before the core pipeline works end to end.
