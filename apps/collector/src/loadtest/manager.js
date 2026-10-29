'use strict';
// Runs load tests and demo traffic for projects, enforces limits, keeps a live timeline in
// memory and the record in the database, and turns each load request into a client span so
// the target's traces are complete and can be listed per run.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomId } = require('../util/secrets');
const { parseTarget, vetHost, verifyToken, hostsFromSpan, TargetError } = require('./target');
const { buildDemoTrace, pickKind } = require('./demoTraffic');

const MAX_TRACE_IDS = 2000;
const MAX_GLOBAL_RUNS = 3;
const LOADTEST_SERVICE = 'tracepipe-loadtest';

class LoadTestManager {
  constructor(ctx) {
    this.ctx = ctx;
    this.runs = new Map(); // id -> live run
    this.hosts = new Map(); // projectId -> Set(host) seen in SERVER spans (ownership evidence)
    this.lookup = undefined; // DNS lookup override (tests)
  }

  // ---------- ownership ----------

  /** Ingest hook: remember which hosts a project's servers report (cheap; SERVER spans only). */
  noteSpans(projectId, spans) {
    for (const s of spans) {
      if (s.kind !== 'SERVER') continue;
      for (const h of hostsFromSpan(s)) {
        let set = this.hosts.get(projectId);
        if (!set) { set = new Set(); this.hosts.set(projectId, set); }
        if (set.size < 200) set.add(h);
      }
    }
  }

  token(projectId) {
    return verifyToken(this.ctx.jwt.privateKey, projectId);
  }

  /**
   * Is this project allowed to load-test this URL?
   * @returns {{ verified: boolean, method?: string, host: string, token: string, answers?, reason? }}
   */
  async verify(projectId, rawUrl) {
    const { env } = this.ctx;
    const u = parseTarget(rawUrl);
    const host = u.hostname.toLowerCase();
    const token = this.token(projectId);
    const answers = await vetHost(host, { allowPrivate: env.loadtest.allowPrivateTargets, ...(this.lookup ? { lookup: this.lookup } : {}) });
    if (this.hosts.get(projectId)?.has(host)) return { verified: true, method: 'telemetry', host, token, answers };
    if (await this._hostInStoredTraces(projectId, host)) return { verified: true, method: 'telemetry', host, token, answers };
    if (await this._tokenFile(u, token, answers)) return { verified: true, method: 'token_file', host, token, answers };
    if (env.loadtest.allowPrivateTargets && answers.every((a) => /^(127\.|::1$)/.test(a.address))) {
      return { verified: true, method: 'local_development', host, token, answers };
    }
    return { verified: false, host, token, reason: `We have not seen traces from ${host} in this project yet, and ${u.origin}/.well-known/otel-pipeline.txt does not contain this project's token.` };
  }

  async _hostInStoredTraces(projectId, host) {
    const rows = await this.ctx.db.all('SELECT spans_json FROM traces WHERE project_id = ? ORDER BY finalized_at DESC LIMIT 300', [projectId]);
    for (const r of rows) {
      for (const s of JSON.parse(r.spans_json)) {
        if (hostsFromSpan(s).includes(host)) { this.noteSpans(projectId, [s]); return true; }
      }
    }
    return false;
  }

  async _tokenFile(u, token, answers) {
    const http = require(u.protocol === 'https:' ? 'node:https' : 'node:http');
    const { pinnedLookup } = require('./target');
    const url = new URL('/.well-known/otel-pipeline.txt', u.origin);
    return new Promise((resolve) => {
      const req = http.get(url, { lookup: pinnedLookup(answers), timeout: 5000, headers: { 'user-agent': 'tracepipe-verify/1.0' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        res.on('end', () => resolve(res.statusCode === 200 && body.includes(token)));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(false));
    });
  }

  // ---------- runs ----------

  activeFor(projectId) {
    return [...this.runs.values()].find((r) => r.projectId === projectId && r.status === 'running') || null;
  }

  _checkCapacity(projectId) {
    if (this.activeFor(projectId)) throw new TargetError('busy', 'A test is already running for this project. Stop it or wait for it to finish.');
    const running = [...this.runs.values()].filter((r) => r.status === 'running').length;
    if (running >= MAX_GLOBAL_RUNS) throw new TargetError('capacity', 'The collector is running the maximum number of tests. Try again in a minute.');
  }

  _limits({ rps, durationS }) {
    const { maxRps, maxDurationS } = this.ctx.env.loadtest;
    if (!Number.isInteger(rps) || rps < 1 || rps > maxRps) throw new TargetError('invalid_rps', `Requests per second must be between 1 and ${maxRps}.`);
    if (!Number.isInteger(durationS) || durationS < 5 || durationS > maxDurationS) throw new TargetError('invalid_duration', `Duration must be between 5 and ${maxDurationS} seconds.`);
  }

  async _record(run) {
    await this.ctx.db.run(
      'INSERT INTO load_tests (id, project_id, user_id, kind, target_url, rps, duration_s, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [run.id, run.projectId, run.userId, run.kind, run.target || null, run.rps, run.durationS, run.status, run.startedAt],
    );
  }

  async _finish(run, status, summary, error) {
    run.status = status;
    run.finishedAt = this.ctx.clock.now();
    run.summary = summary || run.summary || null;
    run.error = error || null;
    await this.ctx.db.run(
      'UPDATE load_tests SET status = ?, finished_at = ?, summary_json = ?, timeline_json = ?, trace_ids_json = ?, error = ? WHERE id = ?',
      [status, run.finishedAt, JSON.stringify(run.summary), JSON.stringify(run.timeline), JSON.stringify([...run.traceIds]), run.error, run.id],
    ).catch((err) => this.ctx.logger?.warn?.('saving load test failed:', err.message));
    // keep finished runs in memory briefly for the live view, then rely on the database
    setTimeout(() => this.runs.delete(run.id), 10 * 60_000).unref?.();
  }

  /** Start an HTTP load test against a verified URL. */
  async start(projectId, userId, { url, rps, durationS, method = 'GET' }) {
    this._limits({ rps, durationS });
    if (!['GET', 'HEAD', 'POST'].includes(method)) throw new TargetError('invalid_method', 'Method must be GET, HEAD or POST.');
    this._checkCapacity(projectId);
    const v = await this.verify(projectId, url);
    if (!v.verified) throw new TargetError('not_verified', v.reason);
    const run = this._newRun({ projectId, userId, kind: 'http', target: parseTarget(url).toString(), rps, durationS, method, verifiedBy: v.method });
    await this._record(run);
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: { url: run.target, method, rps, durationS, answers: v.answers, maxInFlight: Math.min(500, Math.max(20, rps * 4)) },
    });
    run.stop = () => worker.postMessage('stop');
    worker.on('message', (m) => {
      if (m.spans?.length) this._ingestClientSpans(run, m.spans);
      if (m.type === 'tick') run.timeline.push(m.point);
      if (m.type === 'done') {
        this._finish(run, m.summary.stopped ? 'stopped' : 'completed', m.summary);
        worker.terminate().catch(() => {});
      }
    });
    worker.on('error', (err) => this._finish(run, 'failed', null, err.message));
    worker.on('exit', (code) => { if (run.status === 'running') this._finish(run, 'failed', null, `load generator exited (${code})`); });
    return run;
  }

  /** Start simulated traffic for a project (no target, no verification needed). */
  async startDemo(projectId, userId, { rps, durationS }) {
    this._limits({ rps, durationS });
    this._checkCapacity(projectId);
    const run = this._newRun({ projectId, userId, kind: 'demo', target: null, rps, durationS });
    await this._record(run);
    const { queue, config, metrics, clock } = this.ctx;
    let second = 0;
    let carry = 0;
    const totals = { traces: 0, spans: 0, kinds: {} };
    const win = { traces: 0, spans: 0, errors: 0 };
    const tick = setInterval(() => {
      if (run.status !== 'running') return;
      carry += rps / 10;
      while (carry >= 1) {
        carry -= 1;
        const kind = pickKind();
        const spans = buildDemoTrace(projectId, kind, clock.now());
        if (queue.size + spans.length > config.get().queue_hard_limit) { metrics.c.rejected_spans += spans.length; continue; }
        metrics.c.spans_received += spans.length;
        metrics.c.spans_accepted += spans.length;
        metrics.ingestRate.add(spans.length);
        this.ctx.onSpansAccepted?.(projectId, spans);
        queue.push(spans);
        if (run.traceIds.size < MAX_TRACE_IDS) run.traceIds.add(spans[0].trace_id);
        totals.traces++; totals.spans += spans.length; totals.kinds[kind] = (totals.kinds[kind] || 0) + 1;
        win.traces++; win.spans += spans.length; if (kind === 'error') win.errors++;
      }
    }, 100);
    const report = setInterval(() => {
      second++;
      run.timeline.push({ t: second, sent: win.traces, ok: win.traces - win.errors, failed: win.errors, spans: win.spans });
      win.traces = 0; win.spans = 0; win.errors = 0;
      if (second >= durationS || run.stopRequested) {
        clearInterval(tick); clearInterval(report);
        this._finish(run, run.stopRequested ? 'stopped' : 'completed', { sent: totals.traces, spans: totals.spans, kinds: totals.kinds, seconds: second, stopped: Boolean(run.stopRequested) });
      }
    }, 1000);
    tick.unref?.(); report.unref?.();
    run.stop = () => { run.stopRequested = true; };
    return run;
  }

  _newRun({ projectId, userId, kind, target, rps, durationS, method, verifiedBy }) {
    const run = {
      id: randomId('lt'), projectId, userId, kind, target, rps, durationS, method: method || null, verifiedBy: verifiedBy || null,
      status: 'running', startedAt: this.ctx.clock.now(), finishedAt: null, timeline: [], summary: null, error: null, traceIds: new Set(), stop: () => {},
    };
    this.runs.set(run.id, run);
    return run;
  }

  /** Client spans from the load generator become the root of each request's trace. */
  _ingestClientSpans(run, items) {
    const { queue, config, metrics } = this.ctx;
    const target = new URL(run.target);
    const spans = items.map((s) => {
      const failed = Boolean(s.error) || s.status >= 500;
      if (run.traceIds.size < MAX_TRACE_IDS && (failed || run.traceIds.size < MAX_TRACE_IDS / 2)) run.traceIds.add(s.traceId);
      return {
        project_id: run.projectId, trace_id: s.traceId, span_id: s.spanId, parent_span_id: null,
        service: LOADTEST_SERVICE, operation: `${run.method} ${target.pathname}`, kind: 'CLIENT',
        start_time: s.start, end_time: s.start + Math.round(s.durUs / 1000), duration_us: s.durUs,
        status: failed ? 'ERROR' : 'OK', ...(s.error ? { status_message: s.error } : {}),
        attributes: { 'http.request.method': run.method, 'url.full': run.target, 'server.address': target.hostname, ...(s.status ? { 'http.response.status_code': s.status } : {}), 'loadtest.id': run.id },
      };
    });
    if (queue.size + spans.length > config.get().queue_hard_limit) { metrics.c.rejected_spans += spans.length; return; }
    metrics.c.spans_received += spans.length;
    metrics.c.spans_accepted += spans.length;
    metrics.ingestRate.add(spans.length);
    queue.push(spans);
  }

  async stop(projectId, id) {
    const run = this.runs.get(id);
    if (!run || run.projectId !== projectId || run.status !== 'running') return false;
    run.stop();
    return true;
  }

  view(run) {
    return {
      id: run.id, kind: run.kind, target_url: run.target, rps: run.rps, duration_s: run.durationS, method: run.method, verified_by: run.verifiedBy,
      status: run.status, started_at: run.startedAt, finished_at: run.finishedAt, timeline: run.timeline, summary: run.summary, error: run.error,
      trace_count: run.traceIds.size,
    };
  }

  async get(projectId, id) {
    const live = this.runs.get(id);
    if (live && live.projectId === projectId) return this.view(live);
    const r = await this.ctx.db.get('SELECT * FROM load_tests WHERE id = ? AND project_id = ?', [id, projectId]);
    return r ? fromRow(r) : null;
  }

  async list(projectId) {
    const rows = await this.ctx.db.all('SELECT id, kind, target_url, rps, duration_s, status, started_at, finished_at, summary_json, error FROM load_tests WHERE project_id = ? ORDER BY started_at DESC LIMIT 20', [projectId]);
    return rows.map((r) => {
      const live = this.runs.get(r.id);
      return live ? { ...this.view(live), timeline: undefined } : { ...fromRow(r), timeline: undefined };
    });
  }

  async traceIds(projectId, id) {
    const live = this.runs.get(id);
    if (live && live.projectId === projectId) return [...live.traceIds];
    const r = await this.ctx.db.get('SELECT trace_ids_json FROM load_tests WHERE id = ? AND project_id = ?', [id, projectId]);
    return r?.trace_ids_json ? JSON.parse(r.trace_ids_json) : null;
  }

  stopAll() {
    for (const r of this.runs.values()) if (r.status === 'running') r.stop();
  }
}

function fromRow(r) {
  const ids = r.trace_ids_json ? JSON.parse(r.trace_ids_json) : [];
  return {
    id: r.id, kind: r.kind, target_url: r.target_url, rps: r.rps, duration_s: r.duration_s, status: r.status,
    started_at: r.started_at, finished_at: r.finished_at, summary: r.summary_json ? JSON.parse(r.summary_json) : null,
    timeline: r.timeline_json ? JSON.parse(r.timeline_json) : [], error: r.error, trace_count: ids.length,
  };
}

module.exports = { LoadTestManager, LOADTEST_SERVICE };
