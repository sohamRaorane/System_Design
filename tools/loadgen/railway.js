'use strict';
// Railway Reservation load generator.
//   node loadgen/railway.js --rate 20 --duration 60 [--mix error=5,slow=5,success=90] [--seed 42]
//   node loadgen/railway.js --burst 15000
//   add --key otk_... (or INGEST_KEY=...) to send into a project instead of "default"
const { mulberry32 } = require('../../apps/collector/src/util/common');
const { hashToUnit } = require('../../apps/collector/src/sample/sampler');
const { DEFAULT_MIX, TYPES, pickType, parseMix, buildTrace } = require('./scenarios');

const MAX_BATCH = 50;
const MAX_LOCAL_BUFFER = 10000;

function parseArgs(argv) {
  const a = { rate: 20, duration: 60, burst: 0, seed: null, mix: DEFAULT_MIX, url: process.env.COLLECTOR_URL || 'http://localhost:4318', sampleRate: 0.1, key: process.env.INGEST_KEY || '' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--rate') a.rate = Number(v());
    else if (k === '--duration') a.duration = Number(v());
    else if (k === '--burst') a.burst = Number(v());
    else if (k === '--seed') a.seed = Number(v());
    else if (k === '--mix') a.mix = parseMix(v());
    else if (k === '--url') a.url = v();
    else if (k === '--normal-rate') a.sampleRate = Number(v());
    else if (k === '--key') a.key = v();
    else throw new Error(`unknown flag ${k}`);
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sends batches serially; honours 429 Retry-After; retries network errors with backoff. */
class Sender {
  constructor(url, log = () => {}, key = '') {
    this.url = url.replace(/\/$/, '') + '/v1/traces';
    this.headers = { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) };
    this.log = log;
    this.outbox = []; // { due, span }
    this.stats = { requests: 0, spans_sent: 0, throttled_429: 0, network_retries: 0, dropped_local: 0, invalid: 0 };
    this.running = false;
  }

  enqueue(span, delayMs = 0) {
    if (this.outbox.length >= MAX_LOCAL_BUFFER) {
      this.stats.dropped_local++;
      return;
    }
    this.outbox.push({ due: Date.now() + delayMs, span });
  }

  get backlog() {
    return this.outbox.length;
  }

  async post(batch) {
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(this.url, { method: 'POST', headers: this.headers, body: JSON.stringify({ spans: batch }) });
        if (res.status === 429) {
          this.stats.throttled_429++;
          const wait = Number(res.headers.get('retry-after') || 1) * 1000;
          this.log(`429: waiting ${wait} ms`);
          await sleep(wait);
          continue;
        }
        const body = await res.json().catch(() => ({}));
        this.stats.requests++;
        if (res.ok) this.stats.spans_sent += body.accepted ?? batch.length;
        this.stats.invalid += body.rejected || 0;
        return true;
      } catch (err) {
        attempt++;
        this.stats.network_retries++;
        const wait = Math.min(10000, 250 * 2 ** Math.min(attempt, 6));
        this.log(`network error (${err.cause?.code || err.message}); retry ${attempt} in ${wait} ms`);
        await sleep(wait); // after 5 attempts the batch stays in the local buffer and we keep trying
      }
    }
  }

  async run(isDone) {
    this.running = true;
    while (this.running && !(isDone() && this.outbox.length === 0)) {
      const now = Date.now();
      const due = [];
      const rest = [];
      for (const item of this.outbox) (item.due <= now && due.length < MAX_BATCH ? due : rest).push(item);
      if (!due.length) {
        await sleep(25);
        continue;
      }
      this.outbox = rest;
      await this.post(due.map((d) => d.span));
    }
  }
}

async function runSteady(args) {
  const rng = mulberry32(args.seed ?? Math.floor(Math.random() * 2 ** 32));
  const sender = new Sender(args.url, (m) => console.log('[loadgen]', m), args.key);
  const sent = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const expect = { spans_total: 0, duplicate_spans: 0, normal_sampled_expected: 0 };
  let finished = false;
  const senderDone = sender.run(() => finished);

  const end = Date.now() + args.duration * 1000;
  const interval = 1000 / args.rate;
  let next = Date.now();
  while (Date.now() < end) {
    const type = pickType(rng, args.mix);
    const t0 = Date.now();
    const tr = buildTrace(type, rng, t0);
    sent[type]++;
    expect.spans_total += tr.spans.length;
    if (type === 'success' || type === 'duplicate') {
      if (hashToUnit(tr.trace_id) < args.sampleRate) expect.normal_sampled_expected++;
    }
    for (const s of tr.spans) sender.enqueue(s, Math.floor(rng() * 300)); // shuffled arrival, 0-300 ms
    for (const s of tr.duplicated) {
      sender.enqueue(s, 1000);
      expect.duplicate_spans++;
    }
    next += interval;
    await sleep(Math.max(0, next - Date.now()));
  }
  finished = true;
  await senderDone;
  report(sent, expect, sender.stats);
  return { sent, expect, stats: sender.stats };
}

async function runBurst(args) {
  const rng = mulberry32(args.seed ?? 1);
  const sender = new Sender(args.url, (m) => console.log('[loadgen]', m), args.key);
  const sent = Object.fromEntries(TYPES.map((t) => [t, 0]));
  const expect = { spans_total: 0, duplicate_spans: 0, normal_sampled_expected: 0 };
  const all = [];
  while (all.length < args.burst) {
    const type = pickType(rng, args.mix);
    const tr = buildTrace(type, rng, Date.now());
    sent[type]++;
    if (type === 'success' || type === 'duplicate') if (hashToUnit(tr.trace_id) < args.sampleRate) expect.normal_sampled_expected++;
    all.push(...tr.spans, ...tr.duplicated);
    expect.duplicate_spans += tr.duplicated.length;
  }
  expect.spans_total = all.length;
  const started = Date.now();
  const CHUNK = 1000; // server maximum per request
  for (let i = 0; i < all.length; i += CHUNK) await sender.post(all.slice(i, i + CHUNK));
  console.log(`[loadgen] burst of ${all.length} spans took ${Date.now() - started} ms`);
  report(sent, expect, sender.stats);
}

function report(sent, expect, stats) {
  console.log('\n=== load generator summary ===');
  console.log('traces sent by type:', JSON.stringify(sent));
  console.log('expected at collector:', JSON.stringify({
    'kept_by_reason.ERROR': sent.payment_error,
    'kept_by_reason.HIGH_LATENCY': sent.slow,
    'kept_by_reason.INCOMPLETE': sent.incomplete,
    'kept_by_reason.NORMAL_SAMPLED': expect.normal_sampled_expected,
    duplicate_spans: expect.duplicate_spans,
  }));
  console.log('sender stats:', JSON.stringify(stats));
  console.log('(compare with GET /metrics after trace_timeout_ms + batch_flush_interval_ms + 5 s)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.burst > 0) await runBurst(args);
  else await runSteady(args);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { Sender, parseArgs, runSteady };
