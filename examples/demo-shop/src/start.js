'use strict';
// Starts the three services as separate processes (one service.name each) with
// OpenTelemetry zero-code instrumentation preloaded with --require — the same
// setup the pipeline's "Connect repo" pull request adds to a user's app.
//
// Environment (set these on Render / your shell):
//   PORT                            public port of the gateway (default 3000)
//   OTEL_EXPORTER_OTLP_ENDPOINT     the collector URL, e.g. https://<your-collector>.onrender.com
//   OTEL_EXPORTER_OTLP_HEADERS      x-api-key=<project ingest key>
//   OTEL_PIPELINE_VERIFY_TOKEN      optional; served at /.well-known/otel-pipeline.txt
const { fork } = require('node:child_process');
const path = require('node:path');

const ROLE = process.env.DEMO_ROLE;
const host = '127.0.0.1';
const ORDERS_PORT = Number(process.env.ORDERS_PORT || 4101);
const PAYMENTS_PORT = Number(process.env.PAYMENTS_PORT || 4102);

if (ROLE) {
  const svc = require('./services');
  if (ROLE === 'gateway') {
    svc.gateway({ port: Number(process.env.PORT || 3000), host: '0.0.0.0', ordersUrl: `http://${host}:${ORDERS_PORT}`, verifyToken: process.env.OTEL_PIPELINE_VERIFY_TOKEN });
  } else if (ROLE === 'orders') {
    svc.orders({ port: ORDERS_PORT, host, paymentsUrl: `http://${host}:${PAYMENTS_PORT}` });
  } else if (ROLE === 'payments') {
    svc.payments({ port: PAYMENTS_PORT, host });
  }
} else {
  let register = null;
  try {
    register = require.resolve('@opentelemetry/auto-instrumentations-node/register');
  } catch {
    console.warn('[demo-shop] OpenTelemetry is not installed (run npm install) — starting WITHOUT tracing.');
  }
  if (register && !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.warn('[demo-shop] OTEL_EXPORTER_OTLP_ENDPOINT is not set — spans go to http://localhost:4318 (the local collector).');
  }
  const children = [];
  let stopping = false;
  for (const role of ['payments', 'orders', 'gateway']) {
    const env = {
      ...process.env,
      DEMO_ROLE: role,
      OTEL_SERVICE_NAME: `demo-${role}`,
      OTEL_TRACES_EXPORTER: process.env.OTEL_TRACES_EXPORTER || 'otlp',
      OTEL_METRICS_EXPORTER: process.env.OTEL_METRICS_EXPORTER || 'none',
      OTEL_LOGS_EXPORTER: process.env.OTEL_LOGS_EXPORTER || 'none',
      // Keep the demo's spans focused on HTTP; fs/dns spans are noise here.
      OTEL_NODE_ENABLED_INSTRUMENTATIONS: process.env.OTEL_NODE_ENABLED_INSTRUMENTATIONS || 'http',
    };
    // --require preloads the SDK before any app code (same effect as NODE_OPTIONS, no quoting issues).
    const execArgv = register ? [...process.execArgv, '--require', register] : process.execArgv;
    const child = fork(path.join(__dirname, 'start.js'), [], { env, execArgv });
    child.on('exit', (code) => {
      if (stopping) return;
      console.error(`[demo-shop] ${role} exited with code ${code}; stopping`);
      for (const c of children) c.kill();
      process.exit(code || 1);
    });
    children.push(child);
  }
  const stop = () => { stopping = true; for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
