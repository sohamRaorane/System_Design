'use strict';
// Small shared helpers: clock, logger, stable stringify, RNG.

/** Default clock. now() is wall time (epoch ms); mono() is for internal latencies (E59). */
const systemClock = {
  now: () => Date.now(),
  mono: () => performance.now(),
};

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(level = 'info') {
  const min = LEVELS[level] ?? LEVELS.info;
  const at = (lvl, fn) => (...args) => {
    if (LEVELS[lvl] >= min) fn(`[${new Date().toISOString()}] ${lvl.toUpperCase()}`, ...args);
  };
  return {
    debug: at('debug', console.log),
    info: at('info', console.log),
    warn: at('warn', console.warn),
    error: at('error', console.error),
  };
}

const silentLogger = createLogger('silent');

/** JSON.stringify with sorted object keys, so equal spans compare equal. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Exponential backoff with +/-20% jitter. attempt starts at 1. */
function backoffDelay(attempt, baseMs, maxMs, rng = Math.random) {
  const raw = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.round(raw * (0.8 + rng() * 0.4)));
}

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HEX_PATTERN = /^[0-9a-fA-F]+$/;

/** Normalise an id: hex ids are lower-cased (E8); others are kept as sent. */
function normalizeId(id) {
  return HEX_PATTERN.test(id) ? id.toLowerCase() : id;
}

module.exports = {
  systemClock,
  createLogger,
  silentLogger,
  stableStringify,
  mulberry32,
  backoffDelay,
  unref,
  ID_PATTERN,
  normalizeId,
};
