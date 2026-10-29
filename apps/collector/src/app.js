'use strict';
// App factory: wires every component. All dependencies are injectable so tests can build an
// isolated pipeline (temp db, fake clock, seeded RNG). Async because opening the database
// runs migrations.
const path = require('node:path');
const express = require('express');
const { RuntimeConfig } = require('./config/runtimeConfig');
const { systemClock, silentLogger } = require('./util/common');
const { createMetrics } = require('./metrics/metrics');
const { createFaults } = require('./faults/faults');
const { openDatabase } = require('./db');
const { TraceRepo } = require('./store/traceRepo');
const { LocalBlobStore } = require('./blob/localStore');
const { SpanQueue } = require('./queue/spanQueue');
const { Aggregator } = require('./aggregate/aggregator');
const { Sampler } = require('./sample/sampler');
const { CircuitBreaker } = require('./batch/circuitBreaker');
const { BatchProcessor } = require('./batch/batchProcessor');
const { ArchiveWorker } = require('./archive/archiveWorker');
const { ColdReader } = require('./archive/coldReader');
const { ingestRouter } = require('./ingest/routes');
const { queryRouter } = require('./query/routes');
const { controlRouter } = require('./control/routes');
const { metricsRouter } = require('./metrics/routes');
const { webRouter } = require('./web');

async function createApp({
  clock = systemClock,
  config = {},
  databaseUrl,
  dbPath = 'data/telemetry.db',
  coldDir = 'cold',
  blob,
  spillDir,
  logger = silentLogger,
  adminToken = process.env.ADMIN_TOKEN || '',
  rng = Math.random,
  hash,
  webDist = process.env.WEB_DIST,
} = {}) {
  const cfg = config instanceof RuntimeConfig ? config : new RuntimeConfig(config, { logger });
  const metrics = createMetrics(clock);
  const faults = createFaults();
  const db = await openDatabase({ databaseUrl, dbPath, logger });
  const blobStore = blob || new LocalBlobStore(coldDir);
  const repo = new TraceRepo({ db, faults, clock, metrics });
  const breaker = new CircuitBreaker({ config: cfg, clock, metrics, logger });
  if (spillDir === undefined) spillDir = databaseUrl || dbPath === ':memory:' ? null : path.join(path.dirname(dbPath), 'spill');
  const batch = new BatchProcessor({ config: cfg, clock, metrics, repo, breaker, faults, spillDir, logger, rng });

  const ctx = { config: cfg, clock, metrics, faults, db, repo, blob: blobStore, breaker, batch, logger, adminToken };
  // queue <-> aggregator <-> sampler are wired through closures to avoid construction cycles.
  const queue = new SpanQueue({ config: cfg, faults, clock, logger, consumer: (s) => ctx.aggregator.addSpan(s) });
  const sampler = new Sampler({ config: cfg, queue, metrics, hash });
  const aggregator = new Aggregator({ config: cfg, clock, metrics, sampler, sink: batch, logger });
  const archiver = new ArchiveWorker({ config: cfg, clock, metrics, repo, faults, blob: blobStore, logger });
  const coldReader = new ColdReader({ repo, blob: blobStore, metrics });
  Object.assign(ctx, { queue, sampler, aggregator, archiver, coldReader });

  const app = express();
  app.disable('x-powered-by');
  app.use(ingestRouter(ctx));
  app.use(queryRouter(ctx));
  app.use(controlRouter(ctx));
  app.use(metricsRouter(ctx));
  if (webDist) app.use(webRouter(webDist));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: err.type || 'bad_request' });
    logger.error('unhandled', err);
    res.status(500).json({ error: 'internal_error' });
  });

  let started = false;
  let closed = false;
  ctx.start = () => {
    if (started) return;
    started = true;
    queue.start();
    aggregator.start();
    batch.start();
    archiver.start();
  };

  /** Graceful shutdown (E55): stop intake work, drain queue, finalize open traces, flush, close DB. */
  ctx.shutdown = async () => {
    if (closed) return;
    closed = true;
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
