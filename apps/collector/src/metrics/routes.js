'use strict';
// GET /metrics and GET /health (section 5.11).
const express = require('express');
const { snapshot } = require('./metrics');

function metricsRouter(ctx) {
  const router = express.Router();

  // Operators: /metrics (X-Admin-Token in production). Dashboard users: /api/pipeline.
  router.get('/metrics', ctx.auth.operatorGuard, async (req, res) => res.json(await snapshot(ctx.metrics, ctx)));
  router.get('/api/pipeline', ctx.auth.requireUser, async (req, res) => res.json(await snapshot(ctx.metrics, ctx)));

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
