'use strict';
// Projects and their ingest API keys. A key is shown once at creation; only its SHA-256 is
// stored, looked up by a short public prefix.
const { randomId, randomToken, sha256 } = require('../util/secrets');

const KEY_RE = /^otk_([A-Za-z0-9_-]{8})_([A-Za-z0-9_-]{20,})$/;

/** Per-project tunables and their limits (everything else uses the global pipeline config). */
const SETTINGS_SCHEMA = {
  normal_sampling_rate: { min: 0, max: 1, int: false },
  latency_threshold_ms: { min: 1, max: 600000, int: true },
  hot_retention_days: { min: 0.001, max: 36500, int: false },
};

function validateSettings(patch) {
  const errors = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [{ field: 'settings', reason: 'must be an object' }];
  for (const [k, v] of Object.entries(patch)) {
    const rule = SETTINGS_SCHEMA[k];
    if (!rule) { errors.push({ field: k, reason: 'unknown setting' }); continue; }
    if (v === null) continue; // null = back to the global default
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ field: k, reason: 'must be a number' });
    else if (rule.int && !Number.isInteger(v)) errors.push({ field: k, reason: 'must be a whole number' });
    else if (v < rule.min || v > rule.max) errors.push({ field: k, reason: `must be between ${rule.min} and ${rule.max}` });
  }
  return errors;
}

const toProject = (r) => (r ? { ...r, settings: JSON.parse(r.settings_json || '{}'), settings_json: undefined } : null);

class ProjectRepo {
  constructor({ db, clock }) {
    this.db = db;
    this.clock = clock;
  }

  async create({ ownerId, name }) {
    const id = randomId('prj');
    await this.db.run('INSERT INTO projects (id, owner_id, name, settings_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, ownerId, name, '{}', this.clock.now()]);
    return this.get(id);
  }

  async get(id) {
    return toProject(await this.db.get('SELECT * FROM projects WHERE id = ?', [id]));
  }

  async listFor(user) {
    const rows = user.admin
      ? await this.db.all("SELECT * FROM projects WHERE owner_id = ? OR id = 'default' ORDER BY created_at DESC", [user.id])
      : await this.db.all('SELECT * FROM projects WHERE owner_id = ? ORDER BY created_at DESC', [user.id]);
    return rows.map(toProject);
  }

  async all() {
    return (await this.db.all('SELECT * FROM projects')).map(toProject);
  }

  async update(id, { name, settings }) {
    if (name !== undefined) await this.db.run('UPDATE projects SET name = ? WHERE id = ?', [name, id]);
    if (settings !== undefined) {
      const current = (await this.get(id)).settings;
      const next = { ...current, ...settings };
      for (const k of Object.keys(next)) if (next[k] === null) delete next[k];
      await this.db.run('UPDATE projects SET settings_json = ? WHERE id = ?', [JSON.stringify(next), id]);
    }
    return this.get(id);
  }

  async remove(id) {
    await this.db.tx(async (q) => {
      for (const table of ['traces', 'trace_services', 'archive_index', 'api_keys']) await q.run(`DELETE FROM ${table} WHERE project_id = ?`, [id]);
      await q.run('DELETE FROM projects WHERE id = ?', [id]);
    });
  }

  async markFirstTrace(id, at) {
    await this.db.run('UPDATE projects SET first_trace_at = ? WHERE id = ? AND first_trace_at IS NULL', [at, id]);
  }

  async touch(id, at) {
    await this.db.run('UPDATE projects SET last_span_at = ? WHERE id = ?', [at, id]);
  }

  // ---------- keys ----------

  async createKey(projectId, label) {
    const prefix = randomToken(6).slice(0, 8);
    const plaintext = `otk_${prefix}_${randomToken(24)}`;
    const id = randomId('key');
    await this.db.run('INSERT INTO api_keys (id, project_id, prefix, hash, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, projectId, prefix, sha256(plaintext), label || null, this.clock.now()]);
    return { id, prefix, plaintext, label: label || null };
  }

  async listKeys(projectId) {
    return this.db.all('SELECT id, prefix, label, created_at, last_used_at, revoked_at FROM api_keys WHERE project_id = ? ORDER BY created_at DESC', [projectId]);
  }

  async revokeKey(projectId, keyId) {
    const r = await this.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND project_id = ? AND revoked_at IS NULL', [this.clock.now(), keyId, projectId]);
    return r.changes > 0;
  }

  async keyByPrefix(prefix) {
    return (await this.db.get('SELECT * FROM api_keys WHERE prefix = ?', [prefix])) || null;
  }

  async keyUsed(keyId, at) {
    await this.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', [at, keyId]);
  }

  /** Traces kept per reason in a time window (dashboard). */
  async keptByReason(projectId, since) {
    const rows = await this.db.all('SELECT sample_reason, COUNT(*) AS n FROM traces WHERE project_id = ? AND finalized_at >= ? GROUP BY sample_reason', [projectId, since]);
    const out = { ERROR: 0, HIGH_LATENCY: 0, INCOMPLETE: 0, NORMAL_SAMPLED: 0 };
    for (const r of rows) out[r.sample_reason] = Number(r.n);
    return out;
  }
}

module.exports = { ProjectRepo, KEY_RE, SETTINGS_SCHEMA, validateSettings };
