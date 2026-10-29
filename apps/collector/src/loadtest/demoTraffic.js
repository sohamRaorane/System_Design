'use strict';
// Simulated traffic for a project: realistic multi-service traces generated in-process and fed
// straight into the pipeline (no HTTP), so the whole product can be explored before any app
// is connected. Mix: mostly healthy, some payment failures, some slow inventory calls, a few
// traces with a missing span (incomplete).
const crypto = require('node:crypto');

const hex = (n) => crypto.randomBytes(n).toString('hex');
const ROUTES = [
  { op: 'POST /checkout', weight: 5 },
  { op: 'GET /products', weight: 3 },
  { op: 'GET /cart', weight: 2 },
];

function pickRoute() {
  const total = ROUTES.reduce((a, r) => a + r.weight, 0);
  let x = Math.random() * total;
  for (const r of ROUTES) { x -= r.weight; if (x < 0) return r.op; }
  return ROUTES[0].op;
}

/** One trace's spans. kind: 'ok' | 'error' | 'slow' | 'incomplete'. */
function buildDemoTrace(projectId, kind, now = Date.now()) {
  const traceId = hex(16);
  const op = pickRoute();
  const ids = { gw: hex(8), auth: hex(8), svc: hex(8), db: hex(8), pay: hex(8) };
  const span = (id, parent, service, operation, start, dur, extra = {}) => ({
    project_id: projectId, trace_id: traceId, span_id: id, parent_span_id: parent, service, operation,
    start_time: start, end_time: start + dur, duration_us: dur * 1000, status: 'OK', kind: 'SERVER', attributes: {}, ...extra,
  });
  const t = now;
  const authDur = 4 + Math.floor(Math.random() * 6);
  const spans = [span(ids.auth, ids.gw, 'auth', 'verify session', t + 2, authDur, { kind: 'INTERNAL' })];
  let end = t + 2 + authDur;
  if (op === 'POST /checkout') {
    const slow = kind === 'slow';
    const invDur = slow ? 2400 + Math.floor(Math.random() * 600) : 15 + Math.floor(Math.random() * 25);
    spans.push(span(ids.svc, ids.gw, 'inventory', 'reserve items', end + 1, invDur, { attributes: { 'shop.items': 1 + Math.floor(Math.random() * 3) } }));
    spans.push(span(ids.db, ids.svc, 'inventory', 'UPDATE stock', end + 3, Math.max(2, invDur - 6), { kind: 'CLIENT', attributes: { 'db.system': 'postgresql' } }));
    end += invDur + 2;
    const payDur = 60 + Math.floor(Math.random() * 60);
    const failed = kind === 'error';
    spans.push(span(ids.pay, ids.gw, 'payments', 'charge card', end, payDur, failed ? {
      status: 'ERROR', status_message: 'card declined by issuer',
      events: [{ name: 'exception', time: end + payDur - 2, attributes: { 'exception.type': 'CardDeclinedError', 'exception.message': 'card declined by issuer' } }],
    } : { attributes: { 'payment.provider': 'demo-pay' } }));
    end += payDur;
  } else {
    const dur = kind === 'slow' ? 2300 + Math.floor(Math.random() * 500) : 8 + Math.floor(Math.random() * 30);
    spans.push(span(ids.svc, ids.gw, 'catalog', op === 'GET /cart' ? 'load cart' : 'list products', end + 1, dur, kind === 'error' ? { status: 'ERROR', status_message: 'catalog unavailable' } : {}));
    end += dur + 1;
  }
  const rootStatus = kind === 'error' ? 'ERROR' : 'OK';
  spans.unshift(span(ids.gw, null, 'gateway', op, t, end - t + 2, { status: rootStatus, attributes: { 'http.request.method': op.split(' ')[0], 'http.route': op.split(' ')[1], 'http.response.status_code': kind === 'error' ? 502 : 200 } }));
  if (kind === 'incomplete') spans.splice(0, 1); // the gateway's span never arrives: no root, so the trace stays incomplete
  return spans;
}

function pickKind() {
  const x = Math.random() * 100;
  if (x < 8) return 'error';
  if (x < 14) return 'slow';
  if (x < 17) return 'incomplete';
  return 'ok';
}

module.exports = { buildDemoTrace, pickKind };
