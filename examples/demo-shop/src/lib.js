'use strict';
// Shared helpers: a tiny JSON HTTP server/client on node:http (auto-instrumented by
// @opentelemetry/instrumentation-http, which also propagates the W3C traceparent header).
const http = require('node:http');

let otel = null;
try {
  otel = require('@opentelemetry/api');
} catch {
  // Running without OpenTelemetry installed: the shop still works, just untraced.
}

/** Record an exception on the active span (shows up as an "exception" event in the trace). */
function recordError(err) {
  const span = otel?.trace.getActiveSpan();
  if (!span) return;
  span.recordException(err);
  span.setStatus({ code: otel.SpanStatusCode.ERROR, message: err.message });
}

/** Add attributes to the active span (business context such as order id or amount). */
function annotate(attrs) {
  otel?.trace.getActiveSpan()?.setAttributes(attrs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(Object.assign(new Error('invalid JSON body'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json', ...headers });
  res.end(isText ? body : JSON.stringify(body));
}

/** POST JSON to another service; resolves { status, body }. */
function callJson(url, payload, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload || {}));
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let parsed = body;
        try { parsed = JSON.parse(body); } catch { /* keep text */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout calling ${url}`)));
    req.on('error', reject);
    req.end(data);
  });
}

/** Minimal router: routes = { 'GET /path': handler }. Handlers may throw { status }. */
function serve(name, port, host, routes) {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return send(res, 404, { error: 'not_found' });
    try {
      await handler(req, res);
    } catch (err) {
      if (!err.status || err.status >= 500) recordError(err);
      if (!res.headersSent) send(res, err.status || 500, { error: err.message });
    }
  });
  server.listen(port, host, () => console.log(`[${name}] listening on http://${host}:${port}`));
  return server;
}

module.exports = { serve, send, readJson, callJson, recordError, annotate, sleep };
