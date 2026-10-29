'use strict';
// End-to-end reconciliation (section 9.3). Run against a freshly reset, running collector:
//   npm run reset && npm start        (in another terminal)
//   node scripts/reconcile.js [--duration 120] [--wait 40] [--url http://localhost:4318] [--storage-outage]
const { runSteady, parseArgs } = require('../loadgen/railway');

const argv = process.argv.slice(2);
const flag = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const duration = Number(flag('--duration', 120));
const waitS = Number(flag('--wait', 40));
const url = flag('--url', 'http://localhost:4318');
const outage = argv.includes('--storage-outage');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const put = (p, body) => fetch(url + p, { method: 'PUT', headers: { 'content-type': 'application/json', ...(process.env.ADMIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TOKEN } : {}) }, body: JSON.stringify(body) });

(async () => {
  const args = parseArgs(['--seed', '42', '--rate', '20', '--duration', String(duration), '--url', url]);
  if (outage) {
    setTimeout(async () => { console.log('[reconcile] storage_down ON'); await put('/v1/faults', { storage_down: true }); }, (duration / 2) * 1000 - 15000);
    setTimeout(async () => { console.log('[reconcile] storage_down OFF'); await put('/v1/faults', { storage_down: false }); }, (duration / 2) * 1000 + 15000);
  }
  const { sent, expect } = await runSteady(args);
  console.log(`[reconcile] waiting ${waitS}s for timeouts and flushes...`);
  await sleep(waitS * 1000);
  await fetch(url + '/v1/admin/flush', { method: 'POST', headers: process.env.ADMIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TOKEN } : {} });
  await sleep(1500);
  const m = await (await fetch(url + '/metrics')).json();

  const kept = m.sampling.kept_by_reason;
  const totalKept = kept.ERROR + kept.HIGH_LATENCY + kept.INCOMPLETE + kept.NORMAL_SAMPLED;
  const rows = [
    ['kept_by_reason.ERROR', sent.payment_error, kept.ERROR],
    ['kept_by_reason.HIGH_LATENCY', sent.slow, kept.HIGH_LATENCY],
    ['kept_by_reason.INCOMPLETE', sent.incomplete, kept.INCOMPLETE],
    ['kept_by_reason.NORMAL_SAMPLED', expect.normal_sampled_expected, kept.NORMAL_SAMPLED],
    ['duplicate_spans', expect.duplicate_spans, m.aggregation.duplicate_spans],
    ['late_spans', 0, m.aggregation.late_spans],
    ['open_traces', 0, m.aggregation.open_traces],
    ['hot_trace_count', totalKept, m.storage.hot_trace_count],
  ];
  let ok = true;
  console.log('\nmetric'.padEnd(34) + 'expected'.padEnd(10) + 'actual'.padEnd(10) + 'result');
  for (const [name, e, a] of rows) {
    const pass = e === a;
    ok &&= pass;
    console.log(name.padEnd(33) + String(e).padEnd(10) + String(a).padEnd(10) + (pass ? 'OK' : 'MISMATCH'));
  }
  const big = await (await fetch(url + '/v1/traces?limit=200')).json();
  console.log(`\nspot check: max span_count on newest page = ${Math.max(...big.items.map((t) => t.span_count))} (must be <= 6)`);
  ok &&= big.items.every((t) => t.span_count <= 6);
  console.log(ok ? '\nRECONCILIATION PASSED' : '\nRECONCILIATION FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
