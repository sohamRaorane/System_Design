'use strict';
// GET /metrics and GET /health (section 5.11).
const express = require('express');
const { snapshot } = require('./metrics');

function metricsRouter(ctx) {
  const router = express.Router();

  router.get('/metrics', (req, res) => res.json(snapshot(ctx.metrics, ctx)));

  router.get('/health', (req, res) => {
    const reasons = [];
    if (ctx.breaker.state === 'open') reasons.push('circuit breaker open');
    if (ctx.queue.state === 'FULL') reasons.push('queue at hard limit');
    try {
      ctx.repo.ping();
    } catch (err) {
      reasons.push('sqlite unreachable: ' + err.message);
    }
    if (reasons.length) return res.status(503).json({ status: 'unhealthy', reasons });
    res.json({ status: 'ok' });
  });

  return router;
}

module.exports = { metricsRouter };
