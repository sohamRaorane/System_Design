'use strict';
// GET /v1/traces and GET /v1/traces/:id (section 5.9).
const express = require('express');
const { ID_PATTERN, normalizeId } = require('../util/common');
const { BadQuery } = require('../store/traceRepo');

function parseIntParam(q, name, errors, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (q[name] === undefined) return undefined;
  const raw = String(q[name]);
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
    errors.push({ field: name, reason: `must be an integer between ${min} and ${max}` });
    return undefined;
  }
  return Number(raw);
}

function queryRouter({ repo, aggregator, batch, coldReader }) {
  const router = express.Router();

  router.get('/v1/traces', (req, res) => {
    const q = req.query;
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
      if (!['ERROR', 'HIGH_LATENCY', 'INCOMPLETE', 'NORMAL_SAMPLED'].includes(String(q.reason))) {
        errors.push({ field: 'reason', reason: 'unknown sample reason' });
      } else f.reason = String(q.reason);
    }
    if (q.service !== undefined) {
      if (typeof q.service !== 'string' || !q.service || q.service.length > 128) errors.push({ field: 'service', reason: 'invalid' });
      else f.service = q.service.toLowerCase();
    }
    if (q.cursor !== undefined) f.cursor = String(q.cursor);
    if (errors.length) return res.status(400).json({ error: 'invalid_query', errors });
    try {
      const result = repo.query(f);
      if (q.include_archived === 'true') result.archived = repo.queryArchived(f, f.limit ?? 50);
      res.json(result);
    } catch (err) {
      if (err instanceof BadQuery) return res.status(400).json({ error: 'invalid_query', errors: [{ field: 'cursor', reason: err.message }] });
      throw err;
    }
  });

  router.get('/v1/traces/:trace_id', (req, res) => {
    if (!ID_PATTERN.test(req.params.trace_id)) return res.status(400).json({ error: 'invalid_trace_id' });
    const id = normalizeId(req.params.trace_id);
    const hot = repo.getHot(id);
    if (hot) return res.json({ source: 'hot', trace: hot });
    const inFlight = aggregator.peek(id);
    if (inFlight) return res.json({ source: 'in_flight', partial: true, trace: inFlight });
    const pending = batch.findPending(id);
    if (pending) return res.json({ source: 'pending', trace: pending });
    const cold = coldReader.read(id);
    if (cold?.trace) return res.json({ source: 'cold', trace: cold.trace });
    if (cold?.error) return res.status(404).json({ error: 'not_found', archive_error: cold.error });
    res.status(404).json({ error: 'not_found' });
  });

  return router;
}

module.exports = { queryRouter };
