'use strict';
// Trace query: shared filter parsing + the operator API GET /v1/traces[/:id] (section 5.9).
// The operator API reads one project at a time (?project=, default "default").
const express = require('express');
const { ID_PATTERN, normalizeId } = require('../util/common');
const { BadQuery, DEFAULT_PROJECT } = require('../store/traceRepo');

const REASONS = ['ERROR', 'HIGH_LATENCY', 'INCOMPLETE', 'NORMAL_SAMPLED'];

function parseIntParam(q, name, errors, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (q[name] === undefined) return undefined;
  const raw = String(q[name]);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    errors.push({ field: name, reason: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return Number(raw);
}

/** Validate list filters from a query string. Returns { filters, errors }. */
function parseFilters(q) {
  const errors = [];
  const f = {
    min_duration_ms: parseIntParam(q, 'min_duration_ms', errors),
    max_duration_ms: parseIntParam(q, 'max_duration_ms', errors),
    from: parseIntParam(q, 'from', errors),
    to: parseIntParam(q, 'to', errors),
  };
  let limit = parseIntParam(q, 'limit', errors, { min: 1 });
  if (limit !== undefined) limit = Math.min(limit, 200);
  f.limit = limit;
  if (q.status !== undefined) {
    const s = String(q.status).toUpperCase();
    if (s !== 'OK' && s !== 'ERROR') errors.push({ field: 'status', reason: 'must be OK or ERROR' });
    else f.status = s;
  }
  if (q.reason !== undefined) {
    if (!REASONS.includes(String(q.reason))) errors.push({ field: 'reason', reason: 'unknown sample reason' });
    else f.reason = String(q.reason);
  }
  if (q.service !== undefined) {
    if (typeof q.service !== 'string' || !q.service || q.service.length > 128) errors.push({ field: 'service', reason: 'invalid' });
    else f.service = q.service.toLowerCase();
  }
  if (q.cursor !== undefined) f.cursor = String(q.cursor);
  return { filters: f, errors };
}

/** List traces of one project (hot, optionally plus archived summaries). */
async function listTraces(ctx, projectId, q, res, extra = {}) {
  const { filters: parsed, errors } = parseFilters(q);
  if (errors.length) return res.status(400).json({ error: 'invalid_query', errors });
  const filters = { ...parsed, ...extra };
  try {
    const result = await ctx.repo.query(projectId, filters);
    if (q.include_archived === 'true') result.archived = await ctx.repo.queryArchived(projectId, filters, filters.limit ?? 50);
    res.json(result);
  } catch (err) {
    if (err instanceof BadQuery) return res.status(400).json({ error: 'invalid_query', errors: [{ field: 'cursor', reason: err.message }] });
    throw err;
  }
}

/** Find one trace wherever it is: hot store, still being assembled, waiting to be written, or cold. */
async function findTrace(ctx, projectId, rawId, res) {
  if (!ID_PATTERN.test(rawId)) return res.status(400).json({ error: 'invalid_trace_id' });
  const id = normalizeId(rawId);
  const hot = await ctx.repo.getHot(projectId, id);
  if (hot) return res.json({ source: 'hot', trace: hot });
  const inFlight = ctx.aggregator.peek(projectId, id);
  if (inFlight) return res.json({ source: 'in_flight', partial: true, trace: inFlight });
  const pending = ctx.batch.findPending(projectId, id);
  if (pending) return res.json({ source: 'pending', trace: pending });
  const cold = await ctx.coldReader.read(projectId, id);
  if (cold?.trace) return res.json({ source: 'cold', trace: cold.trace });
  if (cold?.error) return res.status(404).json({ error: 'not_found', archive_error: cold.error });
  res.status(404).json({ error: 'not_found' });
}

function projectParam(q) {
  const p = q.project === undefined ? DEFAULT_PROJECT : String(q.project);
  return /^[A-Za-z0-9_-]{1,64}$/.test(p) ? p : null;
}

function queryRouter(ctx, { guard = (req, res, next) => next() } = {}) {
  const router = express.Router();

  router.get('/v1/traces', guard, async (req, res) => {
    const projectId = projectParam(req.query);
    if (!projectId) return res.status(400).json({ error: 'invalid_query', errors: [{ field: 'project', reason: 'invalid' }] });
    await listTraces(ctx, projectId, req.query, res);
  });

  router.get('/v1/traces/:trace_id', guard, async (req, res) => {
    const projectId = projectParam(req.query);
    if (!projectId) return res.status(400).json({ error: 'invalid_query' });
    await findTrace(ctx, projectId, req.params.trace_id, res);
  });

  return router;
}

module.exports = { queryRouter, parseFilters, listTraces, findTrace };
