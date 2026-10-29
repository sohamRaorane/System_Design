'use strict';
// POST /v1/traces (section 5.1). Never touches the aggregator or SQLite directly.
const express = require('express');
const { validateSpan } = require('./validateSpan');

const MAX_SPANS = 1000;

function ingestRouter({ queue, config, metrics, faults, clock }) {
  const router = express.Router();

  router.post(
    '/v1/traces',
    (req, res, next) => (req.is('application/json') ? next() : res.status(415).json({ error: 'unsupported_media_type' })),
    express.json({ limit: '1mb' }),
    async (req, res) => {
      const body = req.body;
      let spans;
      if (Array.isArray(body?.spans)) spans = body.spans;
      else if (body && typeof body === 'object' && !Array.isArray(body) && !('spans' in body)) spans = Object.keys(body).length ? [body] : [];
      else spans = [];
      if (!spans.length) return res.status(400).json({ error: 'no_spans' });
      if (spans.length > MAX_SPANS) return res.status(413).json({ error: 'too_many_spans', max: MAX_SPANS });

      const delay = faults.get('ingest_delay_ms');
      if (delay) await new Promise((r) => setTimeout(r, delay));

      const n = spans.length;
      metrics.c.spans_received += n;
      // Capacity check first: reject the whole request, never half-accept.
      if (queue.size + n > config.get().queue_hard_limit) {
        const drain = Math.max(1, queue.drainRate.rate());
        const retryAfter = Math.min(30, Math.max(1, Math.ceil(queue.size / drain)));
        metrics.c.rejected_spans += n;
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ error: 'overloaded', retry_after_s: retryAfter });
      }

      const now = clock.now();
      const accepted = [];
      const errors = [];
      spans.forEach((raw, index) => {
        const r = validateSpan(raw, now);
        if (r.errors) {
          for (const e of r.errors) errors.push({ index, ...e });
        } else {
          if (r.skewed) metrics.c.clock_skew_spans++;
          accepted.push(r.span);
        }
      });
      const rejected = n - accepted.length;
      metrics.c.spans_accepted += accepted.length;
      metrics.c.spans_invalid += rejected;
      if (accepted.length) {
        metrics.ingestRate.add(accepted.length);
        queue.push(accepted);
      }
      res.status(accepted.length ? 202 : 400).json({ accepted: accepted.length, rejected, errors });
    },
  );

  return router;
}

module.exports = { ingestRouter };
