'use strict';
// Pipeline config, failure drills and admin actions (section 5.10).
// Exposed twice with the same handlers:
//   /v1/config, /v1/faults, /v1/admin/*   operator API (X-Admin-Token, or an admin user)
//   /api/admin/*                          dashboard admin page (admin user)
const express = require('express');

function controlRouter(ctx) {
  const { config, faults, batch, archiver } = ctx;
  const router = express.Router();
  const jsonBody = express.json({ limit: '100kb' });

  const getConfig = (req, res) => res.json({ config: config.get(), version: config.version });
  // Synchronous handler => concurrent PUTs are applied strictly in order (E54).
  const putConfig = (req, res) => {
    const result = config.update(req.body, { ifMatch: req.get('If-Match') });
    if (!result.ok) return res.status(result.status).json({ error: result.status === 409 ? 'version_conflict' : 'invalid_config', errors: result.errors });
    res.json({ config: result.config, version: result.version });
  };
  const getFaults = (req, res) => res.json({ faults: { ...faults.state } });
  const putFaults = (req, res) => {
    const result = faults.update(req.body);
    if (!result.ok) return res.status(400).json({ error: 'invalid_faults', errors: result.errors });
    if (!result.faults.storage_down) batch.flush().catch(() => {});
    res.json({ faults: result.faults });
  };
  const flush = async (req, res) => {
    await batch.flush();
    res.json({ ok: true, pending_batches: batch.pendingCount });
  };
  const archive = async (req, res) => res.json(await archiver.runOnce());

  const op = ctx.auth.operatorGuard;
  router.get('/v1/config', getConfig);
  router.put('/v1/config', op, jsonBody, putConfig);
  router.get('/v1/faults', getFaults);
  router.put('/v1/faults', op, jsonBody, putFaults);
  router.post('/v1/admin/flush', op, flush);
  router.post('/v1/admin/archive/run', op, archive);

  const admin = ctx.auth.requireAdmin;
  router.get('/api/admin/config', admin, getConfig);
  router.put('/api/admin/config', admin, jsonBody, putConfig);
  router.get('/api/admin/faults', admin, getFaults);
  router.put('/api/admin/faults', admin, jsonBody, putFaults);
  router.post('/api/admin/flush', admin, flush);
  router.post('/api/admin/archive/run', admin, archive);

  return router;
}

module.exports = { controlRouter };
