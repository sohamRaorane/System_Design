'use strict';
// GET /metrics and GET /health (section 5.11).
const express = require('express');
const { snapshot, toPrometheus } = require('./metrics');

function metricsRouter(ctx) {
  const router = express.Router();

  // Operators: /metrics (X-Admin-Token in production). Dashboard users: /api/pipeline.
  router.get('/metrics', ctx.auth.operatorGuard, async (req, res) => {
    const snap = await snapshot(ctx.metrics, ctx);
    // Prometheus/Grafana Agent scrape: /metrics?format=prometheus (or Accept: text/plain)
    if (req.query.format === 'prometheus' || /text\/plain/.test(String(req.get('accept') || ''))) {
      return res.type('text/plain; version=0.0.4').send(toPrometheus(snap));
    }
    res.json(snap);
  });
  router.get('/api/pipeline', ctx.auth.requireUser, async (req, res) => res.json(await snapshot(ctx.metrics, ctx)));

  // Liveness for the hosting platform: the process is up and serving. Deliberately ignores
  // the database and breaker, so a storage outage never triggers a restart that would throw
  // away the batches waiting safely in memory. /health is the detailed readiness view.
  router.get('/livez', (req, res) => res.json({ status: 'alive' }));

  router.get('/health', async (req, res) => {
    const reasons = [];
    if (ctx.breaker.state === 'open') reasons.push('circuit breaker open (storage writes paused)');
    if (ctx.queue.state === 'FULL') reasons.push('queue at hard limit');
    try {
      await ctx.repo.ping();
    } catch (err) {
      reasons.push('database unreachable: ' + err.message);
    }
    if (reasons.length) return res.status(503).json({ status: 'unhealthy', reasons });
    res.json({ status: 'ok' });
  });

  return router;
}

module.exports = { metricsRouter };
