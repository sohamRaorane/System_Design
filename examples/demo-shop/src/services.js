'use strict';
// The three services. Each runs in its own process (see start.js) so each reports its own
// service.name, exactly like separately deployed microservices.
const crypto = require('node:crypto');
const { serve, send, readJson, callJson, annotate, sleep } = require('./lib');

const PRODUCTS = [
  { id: 'p1', name: 'Mechanical keyboard', price: 89 },
  { id: 'p2', name: 'USB-C dock', price: 129 },
  { id: 'p3', name: 'Noise-cancelling headphones', price: 199 },
];

// Failure knobs (percent), overridable per request with ?fail=1 / ?slow=1 for demos.
const FAIL_PCT = Number(process.env.DEMO_FAIL_PCT ?? 10);
const SLOW_PCT = Number(process.env.DEMO_SLOW_PCT ?? 5);
const SLOW_MS = Number(process.env.DEMO_SLOW_MS ?? 2500);

function gateway({ port, host, ordersUrl, verifyToken }) {
  const page = `Demo shop is running.

Try:
  GET  /api/products
  POST /api/checkout   {"productId":"p1","quantity":1}
  POST /api/checkout?fail=1   (force a payment failure)
  POST /api/checkout?slow=1   (force a slow payment)
`;
  const routes = {
    'GET /': (req, res) => send(res, 200, page),
    'GET /healthz': (req, res) => send(res, 200, { status: 'ok' }),
    'GET /api/products': async (req, res) => {
      await sleep(5 + Math.random() * 15);
      send(res, 200, { products: PRODUCTS });
    },
    'POST /api/checkout': async (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const body = await readJson(req);
      const product = PRODUCTS.find((p) => p.id === (body.productId || 'p1'));
      if (!product) throw Object.assign(new Error('unknown product'), { status: 400 });
      const quantity = Math.max(1, Math.min(10, Number(body.quantity) || 1));
      annotate({ 'shop.product_id': product.id, 'shop.quantity': quantity });
      const r = await callJson(`${ordersUrl}/orders?${q}`, { productId: product.id, quantity, amount: product.price * quantity });
      if (r.status >= 500) throw Object.assign(new Error(`checkout failed: ${r.body?.error || r.status}`), { status: 502 });
      send(res, r.status, r.body);
    },
  };
  // Ownership proof for the pipeline's load tester (Phase 4): serves the token you set.
  if (verifyToken) routes['GET /.well-known/otel-pipeline.txt'] = (req, res) => send(res, 200, verifyToken);
  return serve('gateway', port, host, routes);
}

function orders({ port, host, paymentsUrl }) {
  return serve('orders', port, host, {
    'POST /orders': async (req, res) => {
      const q = new URL(req.url, 'http://x').search;
      const body = await readJson(req);
      const orderId = 'ord_' + crypto.randomBytes(4).toString('hex');
      annotate({ 'shop.order_id': orderId, 'shop.amount': body.amount });
      await sleep(10 + Math.random() * 20); // "reserve stock"
      const r = await callJson(`${paymentsUrl}/charge${q}`, { orderId, amount: body.amount });
      if (r.status !== 200) throw Object.assign(new Error(`payment failed: ${r.body?.error || r.status}`), { status: 500 });
      send(res, 201, { orderId, status: 'confirmed', paymentId: r.body.paymentId });
    },
  });
}

function payments({ port, host }) {
  return serve('payments', port, host, {
    'POST /charge': async (req, res) => {
      const q = new URL(req.url, 'http://x').searchParams;
      const body = await readJson(req);
      annotate({ 'payment.amount': body.amount, 'payment.order_id': body.orderId });
      const slow = q.get('slow') === '1' || Math.random() * 100 < SLOW_PCT;
      await sleep(slow ? SLOW_MS : 20 + Math.random() * 40);
      if (q.get('fail') === '1' || Math.random() * 100 < FAIL_PCT) {
        throw Object.assign(new Error('card declined by issuer'), { status: 500 });
      }
      send(res, 200, { paymentId: 'pay_' + crypto.randomBytes(4).toString('hex') });
    },
  });
}

module.exports = { gateway, orders, payments, PRODUCTS };
