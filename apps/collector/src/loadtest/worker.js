'use strict';
// Load generator (runs in a worker thread). Sends `rps` requests per second for `durationS`
// seconds to one URL, using pinned DNS answers. Each request carries a W3C traceparent so the
// target's spans join a trace whose root is our client span. Reports once per second.
const { parentPort, workerData } = require('node:worker_threads');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { pinnedLookup } = require('./target');

const { url, method = 'GET', rps, durationS, answers, maxInFlight, timeoutMs = 10_000, headers = {} } = workerData;
const target = new URL(url);
const lib = target.protocol === 'https:' ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: maxInFlight, lookup: pinnedLookup(answers) });

let stopped = false;
let inFlight = 0;
const total = { sent: 0, ok: 0, failed: 0, skipped: 0, codes: {}, latencies: [] };
let win = { sent: 0, ok: 0, failed: 0, skipped: 0, codes: {}, latencies: [] };
let spans = [];

parentPort.on('message', (m) => { if (m === 'stop') stopped = true; });
// The listener must not keep the thread alive: it ends when the timers below are cleared.
parentPort.unref();

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 10) / 10;
};

function fire() {
  if (inFlight >= maxInFlight) { win.skipped++; total.skipped++; return; }
  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const started = Date.now();
  const t0 = process.hrtime.bigint();
  inFlight++;
  win.sent++; total.sent++;
  const finish = (status, error) => {
    inFlight--;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const ok = !error && status < 500;
    const bucket = error ? 'network' : String(status);
    for (const w of [win, total]) {
      if (ok) w.ok++; else w.failed++;
      w.codes[bucket] = (w.codes[bucket] || 0) + 1;
      w.latencies.push(ms);
    }
    if (total.latencies.length > 50_000) total.latencies.splice(0, 10_000);
    spans.push({ traceId, spanId, start: started, durUs: Math.round(ms * 1000), status, error: error ? String(error.code || error.message).slice(0, 120) : null });
  };
  const req = lib.request(target, {
    method,
    agent,
    timeout: timeoutMs,
    headers: { 'user-agent': 'tracepipe-loadtest/1.0', traceparent: `00-${traceId}-${spanId}-01`, ...headers },
  }, (res) => {
    res.on('data', () => {});
    res.on('end', () => finish(res.statusCode));
    res.on('error', (e) => finish(0, e));
  });
  req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
  req.on('error', (e) => finish(0, e));
  req.end();
}

const startedAt = Date.now();
let second = 0;
let carry = 0;
// Spread each second's requests over 10 ticks of 100 ms for a smooth arrival rate.
const tick = setInterval(() => {
  if (stopped) return;
  carry += rps / 10;
  while (carry >= 1) { fire(); carry -= 1; }
}, 100);

const report = setInterval(() => {
  second++;
  parentPort.postMessage({
    type: 'tick',
    point: { t: second, sent: win.sent, ok: win.ok, failed: win.failed, skipped: win.skipped, codes: win.codes, p50: pct(win.latencies, 50), p95: pct(win.latencies, 95), max: win.latencies.length ? Math.round(Math.max(...win.latencies)) : null, in_flight: inFlight },
    spans,
  });
  win = { sent: 0, ok: 0, failed: 0, skipped: 0, codes: {}, latencies: [] };
  spans = [];
  if (second >= durationS || stopped) {
    clearInterval(tick);
    clearInterval(report);
    // give in-flight requests a moment to finish, then report the totals
    const end = Date.now() + Math.min(timeoutMs, 5000);
    const wait = setInterval(() => {
      if (inFlight > 0 && Date.now() < end) return;
      clearInterval(wait);
      parentPort.postMessage({
        type: 'done',
        spans,
        summary: {
          sent: total.sent, ok: total.ok, failed: total.failed, skipped: total.skipped, codes: total.codes,
          p50: pct(total.latencies, 50), p95: pct(total.latencies, 95), p99: pct(total.latencies, 99),
          max: total.latencies.length ? Math.round(Math.max(...total.latencies)) : null,
          seconds: Math.round((Date.now() - startedAt) / 100) / 10, stopped,
        },
      });
      agent.destroy();
    }, 100);
  }
}, 1000);
