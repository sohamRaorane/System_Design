'use strict';
// App factory: wires every component. All dependencies are injectable so tests can build an
// isolated pipeline (temp db, fake clock, seeded RNG, fake GitHub). Async because opening the
// database runs migrations.
const path = require('node:path');
const express = require('express');
const { readEnv } = require('./env');
const { RuntimeConfig } = require('./config/runtimeConfig');
const { systemClock, silentLogger } = require('./util/common');
const { SecretBox } = require('./util/secrets');
const { createMetrics } = require('./metrics/metrics');
const { createFaults } = require('./faults/faults');
const { openDatabase } = require('./db');
const { TraceRepo } = require('./store/traceRepo');
const { AccountRepo } = require('./store/accountRepo');
const { ProjectRepo } = require('./store/projectRepo');
const { ProjectService } = require('./projects/service');
const { projectsRouter } = require('./projects/routes');
const { LocalBlobStore } = require('./blob/localStore');
const { S3BlobStore } = require('./blob/s3Store');
const { SpanQueue } = require('./queue/spanQueue');
const { Aggregator } = require('./aggregate/aggregator');
const { Sampler } = require('./sample/sampler');
const { CircuitBreaker } = require('./batch/circuitBreaker');
const { BatchProcessor } = require('./batch/batchProcessor');
const { ArchiveWorker } = require('./archive/archiveWorker');
const { ColdReader } = require('./archive/coldReader');
const { Jwt, loadSigningKey } = require('./auth/jwt');
const { authMiddleware } = require('./auth/middleware');
const { authRouter } = require('./auth/routes');
const { GitHubClient } = require('./github/client');
const { githubRouter } = require('./github/routes');
const { LoadTestManager } = require('./loadtest/manager');
const { loadtestRouter } = require('./loadtest/routes');
const { ingestRouter } = require('./ingest/routes');
const { queryRouter } = require('./query/routes');
const { controlRouter } = require('./control/routes');
const { metricsRouter } = require('./metrics/routes');
const { webRouter } = require('./web');
const { RateLimiter } = require('./util/rateLimit');

async function createApp({
  env: envOverrides = {},
  clock = systemClock,
  config = {},
  databaseUrl,
  dbPath,
  coldDir,
  blob,
  spillDir,
  logger = silentLogger,
  adminToken,
  rng = Math.random,
  hash,
  webDist,
  fetchImpl,
} = {}) {
  const env = { ...readEnv(), ...envOverrides };
  if (databaseUrl !== undefined) env.databaseUrl = databaseUrl;
  if (dbPath !== undefined) env.dbPath = dbPath;
  if (coldDir !== undefined) env.coldDir = coldDir;
  if (adminToken !== undefined) env.adminToken = adminToken;
  if (webDist !== undefined) env.webDist = webDist;

  const cfg = config instanceof RuntimeConfig ? config : new RuntimeConfig(config, { logger });
  const metrics = createMetrics(clock);
  const faults = createFaults();
  const db = await openDatabase({ databaseUrl: env.databaseUrl, dbPath: env.dbPath, logger, pgSchema: env.pgSchema });
  const localData = !env.databaseUrl && env.dbPath !== ':memory:';
  const blobStore = blob || (env.s3Enabled ? new S3BlobStore({ ...env.s3, fetchImpl: fetchImpl || fetch, clock }) : new LocalBlobStore(env.coldDir));
  const repo = new TraceRepo({ db, faults, clock, metrics });
  const breaker = new CircuitBreaker({ config: cfg, clock, metrics, logger });
  if (spillDir === undefined) spillDir = localData ? path.join(path.dirname(env.dbPath), 'spill') : null;
  const batch = new BatchProcessor({ config: cfg, clock, metrics, repo, breaker, faults, spillDir, logger, rng });

  const signingKey = loadSigningKey({ pem: env.jwtPrivateKey, devKeyFile: localData ? path.join(path.dirname(env.dbPath), 'jwt-dev-key.pem') : null, logger });
  const jwt = new Jwt({ privateKey: signingKey, previousPublicKeys: env.jwtPreviousPublicKeys, clock });
  const box = new SecretBox(signingKey);
  const accounts = new AccountRepo({ db, clock, box });
  const github = new GitHubClient({ ...env.github, fetchImpl: fetchImpl || fetch, clock });
  const projects = new ProjectRepo({ db, clock });
  const projectService = new ProjectService({ projects, env, clock, logger });
  await projectService.load();

  const ctx = { env, config: cfg, clock, metrics, faults, db, repo, accounts, projects, projectService, blob: blobStore, breaker, batch, logger, jwt, box, github };
  ctx.auth = authMiddleware(ctx);
  const ingestBuckets = new RateLimiter({ ratePerSec: env.limits.ingestRps, burst: env.limits.ingestRps * 2, clock });
  ctx.ingestLimiter = { check: (projectId) => ingestBuckets.take(projectId) };
  ctx.authLimiter = new RateLimiter({ ratePerSec: env.limits.authPerMin / 60, burst: env.limits.authPerMin, clock });
  ctx.resolveIngestProject = (req) => projectService.resolve(req);
  ctx.loadtests = new LoadTestManager(ctx);
  ctx.onSpansAccepted = (projectId, spans) => {
    projectService.onSpansAccepted(projectId, spans);
    ctx.loadtests.noteSpans(projectId, spans);
  };
  // queue <-> aggregator <-> sampler are wired through closures to avoid construction cycles.
  const queue = new SpanQueue({ config: cfg, faults, clock, logger, consumer: (s) => ctx.aggregator.addSpan(s) });
  const sampler = new Sampler({ config: cfg, queue, metrics, hash, overrides: (pid) => projectService.overrides(pid) });
  const aggregator = new Aggregator({ config: cfg, clock, metrics, sampler, sink: batch, logger });
  const archiver = new ArchiveWorker({ config: cfg, clock, metrics, repo, faults, blob: blobStore, logger, retentionOverrides: () => projectService.retentionOverrides() });
  const coldReader = new ColdReader({ repo, blob: blobStore, metrics });
  Object.assign(ctx, { queue, sampler, aggregator, archiver, coldReader });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render / Vercel terminate TLS in front of us
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(ingestRouter(ctx));
  app.use(authRouter(ctx));
  app.use(projectsRouter(ctx));
  app.use(githubRouter(ctx));
  app.use(loadtestRouter(ctx));
  app.use(queryRouter(ctx, { guard: ctx.auth.operatorGuard }));
  app.use(controlRouter(ctx));
  app.use(metricsRouter(ctx));
  if (env.webDist) app.use(webRouter(env.webDist));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.type || 'bad_request' });
    logger.error('unhandled', err);
    res.status(500).json({ error: 'internal_error' });
  });

  const timers = [];
  let started = false;
  let closed = false;
  ctx.start = () => {
    if (started) return;
    started = true;
    queue.start();
    aggregator.start();
    batch.start();
    archiver.start();
    const t = setInterval(() => accounts.purgeExpiredSessions().catch(() => {}), 3600_000);
    t.unref?.();
    timers.push(t);
  };

  /** Graceful shutdown (E55): stop intake work, drain queue, finalize open traces, flush, close DB. */
  ctx.shutdown = async () => {
    if (closed) return;
    closed = true;
    for (const t of timers) clearInterval(t);
    ctx.loadtests.stopAll();
    queue.stop();
    archiver.stop();
    queue.drainNow();
    aggregator.finalizeAll('shutdown');
    aggregator.stop();
    const clean = await batch.drainAll();
    batch.stop();
    if (!clean) logger.warn('shutdown: some batches could not be written');
    for (let i = 0; i < 100 && archiver.running; i++) await new Promise((r) => setTimeout(r, 50));
    await db.close();
    return clean;
  };

  return { app, ctx };
}

module.exports = { createApp };
