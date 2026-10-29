'use strict';
// Config, faults and admin endpoints (section 5.10).
const express = require('express');

function controlRouter({ config, faults, batch, archiver, adminToken }) {
  const router = express.Router();
  const jsonBody = express.json({ limit: '100kb' });

  // Mutating control endpoints need X-Admin-Token when ADMIN_TOKEN is set.
  const guard = (req, res, next) => {
    if (adminToken && req.get('X-Admin-Token') !== adminToken) return res.status(401).json({ error: 'unauthorized' });
    next();
  };

  router.get('/v1/config', (req, res) => res.json({ config: config.get(), version: config.version }));

  // Synchronous handler => concurrent PUTs are applied strictly in order (E54).
  router.put('/v1/config', guard, jsonBody, (req, res) => {
    const result = config.update(req.body, { ifMatch: req.get('If-Match') });
    if (!result.ok) return res.status(result.status).json({ error: result.status === 409 ? 'version_conflict' : 'invalid_config', errors: result.errors });
    res.json({ config: result.config, version: result.version });
  });

  router.get('/v1/faults', (req, res) => res.json({ faults: { ...faults.state } }));

  router.put('/v1/faults', guard, jsonBody, (req, res) => {
    const result = faults.update(req.body);
    if (!result.ok) return res.status(400).json({ error: 'invalid_faults', errors: result.errors });
    if (!result.faults.storage_down) batch.flush().catch(() => {});
    res.json({ faults: result.faults });
  });

  router.post('/v1/admin/flush', guard, async (req, res) => {
    await batch.flush();
    res.json({ ok: true, pending_batches: batch.pendingCount });
  });

  router.post('/v1/admin/archive/run', guard, async (req, res) => {
    res.json(await archiver.runOnce());
  });

  return router;
}

module.exports = { controlRouter };
