'use strict';
// Railway Reservation trace shapes (section 5.13). Services: gateway, search, availability,
// booking, payment, notification (the 6 emitting services; the client is the caller).
const DEFAULT_MIX = { success: 70, payment_error: 10, slow: 10, incomplete: 5, duplicate: 5 };
const TYPES = Object.keys(DEFAULT_MIX);
const ROUTES = ['CSMT-PUNE', 'CSMT-NASHIK', 'NDLS-BCT', 'MAS-SBC', 'HWH-NDLS'];

function hex(rng, n) {
  let s = '';
  while (s.length < n) s += Math.floor(rng() * 0x100000000).toString(16).padStart(8, '0');
  return s.slice(0, n);
}

function pickType(rng, mix) {
  const total = TYPES.reduce((a, t) => a + (mix[t] || 0), 0);
  let r = rng() * total;
  for (const t of TYPES) {
    r -= mix[t] || 0;
    if (r < 0) return t;
  }
  return 'success';
}

/** Parse "error=5,slow=5,success=90" into a mix (names: payment_error may be written as error). */
function parseMix(str) {
  const mix = Object.fromEntries(TYPES.map((t) => [t, 0]));
  for (const part of str.split(',')) {
    const [k, v] = part.split('=');
    const key = k.trim() === 'error' ? 'payment_error' : k.trim();
    if (!TYPES.includes(key) || !Number.isFinite(Number(v))) throw new Error(`bad --mix entry "${part}"`);
    mix[key] = Number(v);
  }
  return mix;
}

/**
 * Build one trace. Returns { type, trace_id, spans, expected_spans, duplicated: span[] }.
 * Gateway root covers the request; booking parents payment and notification.
 */
function buildTrace(type, rng, t0) {
  const trace_id = hex(rng, 32);
  const id = () => hex(rng, 16);
  const route = ROUTES[Math.floor(rng() * ROUTES.length)];
  const ids = { gateway: id(), search: id(), availability: id(), booking: id(), payment: id(), notification: id() };
  const availMs = type === 'slow' ? 2500 : 50 + Math.floor(rng() * 40);
  const searchMs = 60 + Math.floor(rng() * 40);
  const payMs = 100 + Math.floor(rng() * 40);
  const notifyMs = 30 + Math.floor(rng() * 20);

  const searchStart = t0 + 5;
  const availStart = searchStart + searchMs;
  const bookStart = availStart + availMs;
  const payStart = bookStart + 10;
  const payEnd = payStart + payMs;
  const notifyStart = payEnd;
  const notifyEnd = notifyStart + notifyMs;
  const bookEnd = notifyEnd + 5;
  const gwEnd = bookEnd + 5;
  const err = type === 'payment_error';

  const mk = (key, service, operation, parent, start, end, status = 'OK', attributes = {}) => ({
    trace_id, span_id: ids[key], parent_span_id: parent ? ids[parent] : null, service, operation,
    start_time: start, end_time: end, status, attributes,
  });
  const spans = [
    mk('gateway', 'gateway', 'POST /bookings', null, t0, gwEnd, err ? 'ERROR' : 'OK', { 'trace.expected_spans': 6, route }),
    mk('search', 'search', 'searchTrains', 'gateway', searchStart, searchStart + searchMs),
    mk('availability', 'availability', 'checkSeats', 'gateway', availStart, availStart + availMs),
    mk('booking', 'booking', 'createBooking', 'gateway', bookStart, bookEnd, err ? 'ERROR' : 'OK'),
    mk('payment', 'payment', 'chargeCard', 'booking', payStart, payEnd, err ? 'ERROR' : 'OK'),
    mk('notification', 'notification', 'sendTicket', 'booking', notifyStart, notifyEnd),
  ];
  const sent = type === 'incomplete' ? spans.filter((s) => s.service !== 'notification') : spans;
  const duplicated = type === 'duplicate' ? [spans[4], spans[5]] : [];
  return { type, trace_id, spans: sent, expected_spans: 6, duplicated };
}

module.exports = { DEFAULT_MIX, TYPES, pickType, parseMix, buildTrace, hex };
