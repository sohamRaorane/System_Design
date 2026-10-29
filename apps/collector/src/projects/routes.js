'use strict';
// Dashboard API for projects (/api/projects/*). Every route checks that the signed-in user
// may see the project; a project's traces are never visible to other users.
const express = require('express');
const { validateSettings } = require('../store/projectRepo');
const { listTraces, findTrace } = require('../query/routes');

const DAY = 86400000;

function projectsRouter(ctx) {
  const { projects, projectService, env, auth } = ctx;
  const router = express.Router();
  const json = express.json({ limit: '50kb' });

  const canSee = (user, p) => p && (p.owner_id === user.id || (p.id === 'default' && user.admin));

  /** Loads :pid into req.project or answers 404 (also when it exists but is not yours). */
  const loadProject = async (req, res, next) => {
    const p = await projects.get(req.params.pid);
    if (!canSee(req.user, p)) return res.status(404).json({ error: 'not_found', message: 'No such project, or you do not have access to it.' });
    req.project = p;
    next();
  };

  const view = (p) => ({
    id: p.id,
    name: p.name,
    created_at: p.created_at,
    first_trace_at: p.first_trace_at || null,
    last_span_at: p.last_span_at || null,
    settings: p.settings,
    is_default: p.id === 'default',
    repo: p.repo_full_name ? { full_name: p.repo_full_name, installation_id: p.repo_installation_id, stack: p.repo_stack, pr_url: p.pr_url } : null,
  });

  /** What a user's app needs to send traces here. */
  const setupFor = (p) => ({
    endpoint: env.publicUrl,
    traces_url: `${env.publicUrl}/v1/traces`,
    header_name: 'x-api-key',
    anonymous_allowed: p.id === 'default' && env.allowAnonymousIngest,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: env.publicUrl,
      OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=<your ingest key>',
      OTEL_SERVICE_NAME: '<your-service-name>',
      OTEL_TRACES_EXPORTER: 'otlp',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    },
  });

  router.use('/api/projects', auth.requireUser);

  router.get('/api/projects', async (req, res) => {
    const list = await projects.listFor(req.user);
    res.json({ projects: list.map((p) => ({ ...view(p), live: projectService.liveStats(p.id) })) });
  });

  router.post('/api/projects', json, async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name || name.length > 80) return res.status(400).json({ error: 'invalid_name', message: 'Give the project a name (up to 80 characters).' });
    const p = await projects.create({ ownerId: req.user.id, name });
    projectService.setSettings(p.id, {});
    const key = await projects.createKey(p.id, 'first key');
    res.status(201).json({ project: view(p), key: { id: key.id, prefix: key.prefix, value: key.plaintext }, setup: setupFor(p) });
  });

  router.get('/api/projects/:pid', loadProject, async (req, res) => {
    res.json({ project: view(req.project), live: projectService.liveStats(req.project.id), setup: setupFor(req.project) });
  });

  router.patch('/api/projects/:pid', loadProject, json, async (req, res) => {
    const { name, settings } = req.body || {};
    const errors = [];
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 80)) errors.push({ field: 'name', reason: '1 to 80 characters' });
    if (settings !== undefined) errors.push(...validateSettings(settings));
    if (errors.length) return res.status(400).json({ error: 'invalid_project', errors });
    if (req.project.id === 'default' && settings !== undefined && !req.user.admin) return res.status(403).json({ error: 'forbidden' });
    const p = await projects.update(req.project.id, { name: name?.trim(), settings });
    projectService.setSettings(p.id, p.settings);
    res.json({ project: view(p) });
  });

  router.delete('/api/projects/:pid', loadProject, async (req, res) => {
    if (req.project.id === 'default') return res.status(400).json({ error: 'cannot_delete_default' });
    await projects.remove(req.project.id);
    projectService.forget(req.project.id);
    res.json({ ok: true });
  });

  // ---------- keys ----------
  router.get('/api/projects/:pid/keys', loadProject, async (req, res) => {
    res.json({ keys: await projects.listKeys(req.project.id) });
  });

  router.post('/api/projects/:pid/keys', loadProject, json, async (req, res) => {
    const label = req.body?.label ? String(req.body.label).slice(0, 60) : null;
    const key = await projects.createKey(req.project.id, label);
    res.status(201).json({ key: { id: key.id, prefix: key.prefix, label: key.label, value: key.plaintext } });
  });

  router.delete('/api/projects/:pid/keys/:keyId', loadProject, async (req, res) => {
    const keys = await projects.listKeys(req.project.id);
    const k = keys.find((x) => x.id === req.params.keyId);
    if (!k || !(await projects.revokeKey(req.project.id, k.id))) return res.status(404).json({ error: 'not_found' });
    projectService.invalidateKey(k.prefix);
    res.json({ ok: true });
  });

  // ---------- traces ----------
  router.get('/api/projects/:pid/traces', loadProject, (req, res) => listTraces(ctx, req.project.id, req.query, res));
  router.get('/api/projects/:pid/traces/:traceId', loadProject, (req, res) => findTrace(ctx, req.project.id, req.params.traceId, res));
  router.get('/api/projects/:pid/services', loadProject, async (req, res) => res.json({ services: await ctx.repo.services(req.project.id) }));

  router.get('/api/projects/:pid/stats', loadProject, async (req, res) => {
    const now = ctx.clock.now();
    const [kept24h, hot, cold] = await Promise.all([
      projects.keptByReason(req.project.id, now - DAY),
      ctx.repo.safeCount('hot', req.project.id),
      ctx.repo.safeCount('cold', req.project.id),
    ]);
    res.json({ live: projectService.liveStats(req.project.id), kept_24h: kept24h, hot_traces: hot, archived_traces: cold, effective: effectiveSettings(ctx, req.project) });
  });

  return router;
}

function effectiveSettings(ctx, p) {
  const g = ctx.config.get();
  const s = p.settings || {};
  return {
    normal_sampling_rate: s.normal_sampling_rate ?? g.normal_sampling_rate,
    latency_threshold_ms: s.latency_threshold_ms ?? g.latency_threshold_ms,
    hot_retention_days: s.hot_retention_days ?? g.hot_retention_days,
    error_sampling_rate: g.error_sampling_rate,
    trace_timeout_ms: g.trace_timeout_ms,
  };
}

module.exports = { projectsRouter };
