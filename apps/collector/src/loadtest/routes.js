'use strict';
// /api/projects/:pid/loadtests* and /api/projects/:pid/demo-traffic
const express = require('express');
const { TargetError } = require('./target');

function loadtestRouter(ctx) {
  const { projects, loadtests, auth, env } = ctx;
  const router = express.Router();
  const json = express.json({ limit: '10kb' });

  const own = async (req, res, next) => {
    const p = await projects.get(req.params.pid);
    if (!p || !(p.owner_id === req.user.id || (p.id === 'default' && req.user.admin))) return res.status(404).json({ error: 'not_found' });
    req.project = p;
    next();
  };
  const fail = (res, err) => {
    if (err instanceof TargetError) {
      const status = { busy: 409, capacity: 429, not_verified: 403, private_address: 400, dns: 400 }[err.code] || 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    throw err;
  };

  const base = '/api/projects/:pid';
  router.get(`${base}/loadtests/limits`, auth.requireUser, own, (req, res) => {
    res.json({ max_rps: env.loadtest.maxRps, max_duration_s: env.loadtest.maxDurationS, verify_token: loadtests.token(req.project.id), verify_path: '/.well-known/otel-pipeline.txt' });
  });

  router.get(`${base}/loadtests/verify`, auth.requireUser, own, async (req, res) => {
    try {
      const v = await loadtests.verify(req.project.id, req.query.url);
      res.json({ verified: v.verified, method: v.method || null, host: v.host, token: v.token, reason: v.reason || null });
    } catch (err) { fail(res, err); }
  });

  router.get(`${base}/loadtests`, auth.requireUser, own, async (req, res) => {
    res.json({ runs: await loadtests.list(req.project.id), active: loadtests.activeFor(req.project.id)?.id || null });
  });

  router.post(`${base}/loadtests`, auth.requireUser, own, json, async (req, res) => {
    try {
      const run = await loadtests.start(req.project.id, req.user.id, {
        url: req.body?.url, rps: Number(req.body?.rps), durationS: Number(req.body?.duration_s), method: String(req.body?.method || 'GET').toUpperCase(),
      });
      res.status(201).json({ run: loadtests.view(run) });
    } catch (err) { fail(res, err); }
  });

  router.post(`${base}/demo-traffic`, auth.requireUser, own, json, async (req, res) => {
    try {
      const run = await loadtests.startDemo(req.project.id, req.user.id, { rps: Number(req.body?.rps ?? 5), durationS: Number(req.body?.duration_s ?? 60) });
      res.status(201).json({ run: loadtests.view(run) });
    } catch (err) { fail(res, err); }
  });

  router.get(`${base}/loadtests/:id`, auth.requireUser, own, async (req, res) => {
    const run = await loadtests.get(req.project.id, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    res.json({ run });
  });

  router.post(`${base}/loadtests/:id/stop`, auth.requireUser, own, async (req, res) => {
    if (!(await loadtests.stop(req.project.id, req.params.id))) return res.status(404).json({ error: 'not_running' });
    res.json({ ok: true });
  });

  return router;
}

module.exports = { loadtestRouter };
