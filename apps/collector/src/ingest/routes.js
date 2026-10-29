'use strict';
// POST /v1/traces — accepts three encodings on one endpoint:
//   * OTLP/HTTP protobuf  (Content-Type: application/x-protobuf)  ← default of OTel SDKs
//   * OTLP/HTTP JSON      (Content-Type: application/json, body has resourceSpans)
//   * legacy flat JSON    (Content-Type: application/json, body has spans[] or one span)
// Responses follow the OTLP/HTTP spec for OTLP requests (200 + optional partialSuccess,
// 429/503 + Retry-After when overloaded) and the original contract for legacy requests.
// The route never touches the aggregator or the database directly: spans go to the queue.
const express = require('express');
const { validateSpan } = require('./validateSpan');
const { translateOtlp, isOtlpJson } = require('./otlp');
const { decodeExportTraceRequest, encodeExportTraceResponse } = require('./protobuf');

const MAX_SPANS = 1000; // per request (OTel SDK batches default to 512)
const BODY_LIMIT = '4mb';
const PROTOBUF_TYPES = ['application/x-protobuf', 'application/protobuf'];

function ingestRouter(ctx) {
  const { queue, config, metrics, faults, clock } = ctx;
  const router = express.Router();
  const resolveProject = (req) => (ctx.resolveIngestProject ? ctx.resolveIngestProject(req) : { projectId: 'default' });

  const contentType = (req, res, next) => {
    if (req.is('application/json') || PROTOBUF_TYPES.some((t) => req.is(t))) return next();
    res.status(415).json({ error: 'unsupported_media_type', accepted: ['application/x-protobuf', 'application/json'] });
  };

  const authenticate = async (req, res, next) => {
    const r = await resolveProject(req);
    if (r.error) {
      metrics.c.unauthorized_requests = (metrics.c.unauthorized_requests || 0) + 1;
      return res.status(r.status || 401).json({ error: r.error, message: r.message });
    }
    req.projectId = r.projectId;
    req.ingestKeyId = r.keyId;
    next();
  };

  const rateLimit = (req, res, next) => {
    if (!ctx.ingestLimiter) return next();
    const verdict = ctx.ingestLimiter.check(req.projectId, req.ingestKeyId);
    if (verdict.ok) return next();
    metrics.c.rate_limited_requests = (metrics.c.rate_limited_requests || 0) + 1;
    res.set('Retry-After', String(verdict.retryAfterS));
    res.status(429).json({ error: 'rate_limited', retry_after_s: verdict.retryAfterS });
  };

  router.post(
    '/v1/traces',
    contentType,
    authenticate,
    rateLimit,
    express.json({ limit: BODY_LIMIT }),
    express.raw({ type: PROTOBUF_TYPES, limit: BODY_LIMIT }),
    async (req, res) => {
      const isProto = Buffer.isBuffer(req.body);
      let format = 'legacy';
      let rawSpans;
      if (isProto) {
        format = 'otlp-proto';
        try {
          rawSpans = translateOtlp(decodeExportTraceRequest(req.body)).spans;
        } catch (err) {
          return res.status(400).json({ error: 'invalid_protobuf', message: err.message });
        }
      } else if (isOtlpJson(req.body)) {
        format = 'otlp-json';
        rawSpans = translateOtlp(req.body).spans;
      } else {
        const body = req.body;
        if (Array.isArray(body?.spans)) rawSpans = body.spans;
        else if (body && typeof body === 'object' && !Array.isArray(body) && !('spans' in body)) rawSpans = Object.keys(body).length ? [body] : [];
        else rawSpans = [];
      }
      const otlp = format !== 'legacy';
      metrics.c.requests_by_format[format] = (metrics.c.requests_by_format[format] || 0) + 1;

      if (!rawSpans.length) {
        // An empty OTLP export is valid (the SDK flushed nothing); a legacy one is a client bug.
        if (otlp) return reply(res, isProto, 200, {});
        return res.status(400).json({ error: 'no_spans' });
      }
      if (rawSpans.length > MAX_SPANS) return res.status(413).json({ error: 'too_many_spans', max: MAX_SPANS });

      const delay = faults.get('ingest_delay_ms');
      if (delay) await new Promise((r) => setTimeout(r, delay));

      const n = rawSpans.length;
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
      rawSpans.forEach((raw, index) => {
        const r = validateSpan(raw, now);
        if (r.errors) {
          for (const e of r.errors) errors.push({ index, ...e });
        } else {
          if (r.skewed) metrics.c.clock_skew_spans++;
          r.span.project_id = req.projectId;
          accepted.push(r.span);
        }
      });
      const rejected = n - accepted.length;
      metrics.c.spans_accepted += accepted.length;
      metrics.c.spans_invalid += rejected;
      if (accepted.length) {
        metrics.ingestRate.add(accepted.length);
        ctx.onSpansAccepted?.(req.projectId, accepted);
        queue.push(accepted);
      }

      if (otlp) {
        if (!rejected) return reply(res, isProto, 200, {});
        const first = errors.slice(0, 3).map((e) => `span ${e.index}: ${e.field} ${e.reason}`).join('; ');
        return reply(res, isProto, 200, { partialSuccess: { rejectedSpans: rejected, errorMessage: first } });
      }
      res.status(accepted.length ? 202 : 400).json({ accepted: accepted.length, rejected, errors });
    },
  );

  // Metrics and logs are outside v1.0's scope (ADR-003). Acknowledge them so a fully
  // configured SDK does not log export errors every few seconds; nothing is stored.
  for (const signal of ['/v1/metrics', '/v1/logs']) {
    router.post(signal, (req, res) => {
      req.resume();
      metrics.c.ignored_signal_requests = (metrics.c.ignored_signal_requests || 0) + 1;
      const proto = PROTOBUF_TYPES.some((t) => req.is(t));
      if (proto) return res.status(200).type('application/x-protobuf').send(Buffer.alloc(0));
      res.status(200).json({});
    });
  }

  return router;
}

function reply(res, isProto, status, body) {
  if (isProto) {
    const ps = body.partialSuccess;
    return res.status(status).type('application/x-protobuf').send(encodeExportTraceResponse(ps || {}));
  }
  return res.status(status).json(body);
}

module.exports = { ingestRouter, MAX_SPANS };
