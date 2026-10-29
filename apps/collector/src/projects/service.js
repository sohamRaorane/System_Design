'use strict';
// Runtime side of projects: resolves ingest keys on the hot path (cached), keeps per-project
// settings in memory for the sampler and archiver, and tracks live per-project activity
// (spans per second, first trace, last span) without a database write per request.
const { KEY_RE } = require('../store/projectRepo');
const { sha256, safeEqualHex } = require('../util/secrets');
const { RollingRate } = require('../metrics/metrics');

const KEY_CACHE_TTL_MS = 60_000;
const TOUCH_EVERY_MS = 10_000;
const KEY_USED_EVERY_MS = 60_000;

class ProjectService {
  constructor({ projects, env, clock, logger }) {
    this.projects = projects;
    this.env = env;
    this.clock = clock;
    this.logger = logger;
    this.settings = new Map(); // projectId -> settings
    this.keyCache = new Map(); // prefix -> { row, at }
    this.live = new Map(); // projectId -> { rate, spans, lastSpanAt, touchedAt, firstSeen }
    this.keyUsedAt = new Map();
    this.listeners = new Set(); // (projectId, event) — e.g. first trace
  }

  async load() {
    for (const p of await this.projects.all()) this.settings.set(p.id, p.settings || {});
  }

  setSettings(projectId, settings) {
    this.settings.set(projectId, settings || {});
  }

  forget(projectId) {
    this.settings.delete(projectId);
    this.live.delete(projectId);
    for (const [prefix, v] of this.keyCache) if (v.row?.project_id === projectId) this.keyCache.delete(prefix);
  }

  /** Sampler hook: per-project overrides merged over the global config. */
  overrides(projectId) {
    return this.settings.get(projectId);
  }

  /** Archive hook: projects whose hot retention differs from the global value. */
  retentionOverrides() {
    const out = [];
    for (const [projectId, s] of this.settings) if (typeof s.hot_retention_days === 'number') out.push({ projectId, days: s.hot_retention_days });
    return out;
  }

  // ---------- ingest authentication ----------

  extractKey(req) {
    const header = req.get('x-api-key') || req.get('x-otel-key');
    if (header) return String(header).trim();
    const auth = String(req.get('authorization') || '');
    if (auth.startsWith('Bearer otk_')) return auth.slice(7).trim();
    return null;
  }

  async resolve(req) {
    const key = this.extractKey(req);
    if (!key) {
      if (this.env.allowAnonymousIngest) return { projectId: 'default' };
      return { error: 'missing_api_key', status: 401, message: 'Send your project ingest key in the x-api-key header (OTEL_EXPORTER_OTLP_HEADERS=x-api-key=otk_...).' };
    }
    const m = KEY_RE.exec(key);
    if (!m) return { error: 'invalid_api_key', status: 401, message: 'This is not a valid ingest key.' };
    const row = await this._keyRow(m[1]);
    if (!row || !safeEqualHex(row.hash, sha256(key))) return { error: 'invalid_api_key', status: 401, message: 'Unknown ingest key.' };
    if (row.revoked_at) return { error: 'revoked_api_key', status: 401, message: 'This ingest key was revoked. Create a new one in project settings.' };
    this._noteKeyUse(row.id);
    return { projectId: row.project_id, keyId: row.id };
  }

  async _keyRow(prefix) {
    const now = this.clock.now();
    const hit = this.keyCache.get(prefix);
    if (hit && now - hit.at < KEY_CACHE_TTL_MS) return hit.row;
    const row = await this.projects.keyByPrefix(prefix);
    this.keyCache.set(prefix, { row, at: now });
    if (this.keyCache.size > 10_000) this.keyCache.delete(this.keyCache.keys().next().value);
    return row;
  }

  invalidateKey(prefix) {
    this.keyCache.delete(prefix);
  }

  _noteKeyUse(keyId) {
    const now = this.clock.now();
    if (now - (this.keyUsedAt.get(keyId) || 0) < KEY_USED_EVERY_MS) return;
    this.keyUsedAt.set(keyId, now);
    this.projects.keyUsed(keyId, now).catch(() => {});
  }

  // ---------- live activity ----------

  onSpansAccepted(projectId, spans) {
    const now = this.clock.now();
    let l = this.live.get(projectId);
    if (!l) {
      l = { rate: new RollingRate(this.clock, 5), spans: 0, lastSpanAt: 0, touchedAt: 0, firstMarked: false };
      this.live.set(projectId, l);
    }
    l.rate.add(spans.length);
    l.spans += spans.length;
    l.lastSpanAt = now;
    if (!l.firstMarked) {
      l.firstMarked = true;
      this.projects.markFirstTrace(projectId, now).then(() => {
        for (const fn of this.listeners) fn(projectId, 'first_span');
      }).catch((err) => this.logger?.warn?.('markFirstTrace failed:', err.message));
    }
    if (now - l.touchedAt > TOUCH_EVERY_MS) {
      l.touchedAt = now;
      this.projects.touch(projectId, now).catch(() => {});
    }
  }

  liveStats(projectId) {
    const l = this.live.get(projectId);
    return { spans_per_sec: l ? l.rate.rate() : 0, spans_since_start: l ? l.spans : 0, last_span_at: l ? l.lastSpanAt || null : null };
  }
}

module.exports = { ProjectService };
