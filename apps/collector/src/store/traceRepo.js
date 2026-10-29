'use strict';
// Hot-tier trace storage and queries (async; SQLite or Postgres through the db adapter).
// Every row is keyed by (project_id, trace_id). Merge-on-write: storing a trace that is
// already stored unions the spans and keeps the higher-priority sample reason (E46).
const { buildTrace } = require('../aggregate/traceBuilder');
const { REASON_PRIORITY } = require('../sample/sampler');

const DEFAULT_PROJECT = 'default';
const SUMMARY_COLS = [
  'project_id', 'trace_id', 'status', 'sample_reason', 'is_complete', 'root_service', 'root_operation',
  'duration_ms', 'span_count', 'created_at', 'finalized_at', 'stored_at',
];

class BadQuery extends Error {}

function encodeCursor(row) {
  return Buffer.from(`${row.finalized_at}:${row.trace_id}`).toString('base64url');
}

function decodeCursor(cursor) {
  try {
    const [fin, ...rest] = Buffer.from(cursor, 'base64url').toString().split(':');
    const id = rest.join(':');
    if (!/^\d+$/.test(fin) || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error();
    return { finalized_at: Number(fin), trace_id: id };
  } catch {
    throw new BadQuery('cursor is invalid');
  }
}

function rowToTrace(row) {
  const spans = JSON.parse(row.spans_json);
  const { spans_json, ...rest } = row;
  return {
    ...rest,
    is_complete: Boolean(row.is_complete),
    spans,
    services: [...new Set(spans.map((s) => s.service))].sort(),
  };
}

const summary = (r, tier = 'hot') => ({ ...r, is_complete: Boolean(r.is_complete), tier });

class TraceRepo {
  constructor({ db, faults, clock, metrics }) {
    this.db = db;
    this.faults = faults;
    this.clock = clock;
    this.metrics = metrics;
  }

  async _upsert(q, incoming, storedAt) {
    const projectId = incoming.project_id || DEFAULT_PROJECT;
    const existingRow = await q.get('SELECT * FROM traces WHERE project_id = ? AND trace_id = ?', [projectId, incoming.trace_id]);
    let t = incoming;
    if (existingRow) {
      const existing = rowToTrace(existingRow);
      const byId = new Map(existing.spans.map((s) => [s.span_id, s]));
      for (const s of incoming.spans) if (!byId.has(s.span_id)) byId.set(s.span_id, s);
      const root = [...byId.values()].find((s) => !s.parent_span_id);
      const merged = buildTrace([...byId.values()], {
        project_id: projectId,
        trace_id: incoming.trace_id,
        rootSpanId: root?.span_id,
        is_complete: existing.is_complete || incoming.is_complete,
        created_at: Math.min(existing.created_at, incoming.created_at),
        finalized_at: Math.max(existing.finalized_at, incoming.finalized_at),
      });
      const reason =
        (REASON_PRIORITY[incoming.sample_reason] || 0) > (REASON_PRIORITY[existing.sample_reason] || 0)
          ? incoming.sample_reason
          : existing.sample_reason;
      t = { ...merged, sample_reason: reason };
    }
    if (!t.sample_reason) throw new Error('trace ' + t.trace_id + ' has no sample_reason');
    await q.run(
      `INSERT INTO traces (${SUMMARY_COLS.join(', ')}, spans_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, trace_id) DO UPDATE SET
         status = excluded.status, sample_reason = excluded.sample_reason, is_complete = excluded.is_complete,
         root_service = excluded.root_service, root_operation = excluded.root_operation,
         duration_ms = excluded.duration_ms, span_count = excluded.span_count, created_at = excluded.created_at,
         finalized_at = excluded.finalized_at, stored_at = excluded.stored_at, spans_json = excluded.spans_json`,
      [projectId, t.trace_id, t.status, t.sample_reason, t.is_complete ? 1 : 0, t.root_service, t.root_operation,
        t.duration_ms, t.span_count, t.created_at, t.finalized_at, storedAt, JSON.stringify(t.spans)],
    );
    await q.run('DELETE FROM trace_services WHERE project_id = ? AND trace_id = ?', [projectId, t.trace_id]);
    for (const s of new Set(t.spans.map((x) => x.service))) {
      await q.run('INSERT INTO trace_services (project_id, trace_id, service) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [projectId, t.trace_id, s]);
    }
  }

  /** One transaction for the whole batch; rejects if storage_down. Resolves to stored_at. */
  async insertBatch(traces) {
    if (this.faults.get('storage_down')) throw new Error('storage unavailable (injected fault)');
    const storedAt = this.clock.now();
    await this.db.tx(async (q) => {
      for (const t of traces) await this._upsert(q, t, storedAt);
    });
    return storedAt;
  }

  async getHot(projectId, traceId) {
    const row = await this.db.get('SELECT * FROM traces WHERE project_id = ? AND trace_id = ?', [projectId, traceId]);
    return row ? rowToTrace(row) : null;
  }

  async getArchiveEntry(projectId, traceId) {
    return (await this.db.get('SELECT * FROM archive_index WHERE project_id = ? AND trace_id = ?', [projectId, traceId])) || null;
  }

  async count(tier, projectId) {
    const table = tier === 'hot' ? 'traces' : 'archive_index';
    const where = projectId ? ' WHERE project_id = ?' : '';
    const r = await this.db.get(`SELECT COUNT(*) AS n FROM ${table}${where}`, projectId ? [projectId] : []);
    return Number(r.n);
  }

  async safeCount(tier, projectId) {
    try { return await this.count(tier, projectId); } catch { return null; }
  }

  ping() {
    return this.db.ping();
  }

  /** Cursor-paged search over the hot tier of one project. */
  async query(projectId, f = {}) {
    const where = ['t.project_id = ?'];
    const params = [projectId];
    let join = '';
    if (f.service) {
      join = 'JOIN trace_services ts ON ts.project_id = t.project_id AND ts.trace_id = t.trace_id';
      where.push('ts.service = ?'); params.push(f.service);
    }
    if (f.status) { where.push('t.status = ?'); params.push(f.status); }
    if (f.reason) { where.push('t.sample_reason = ?'); params.push(f.reason); }
    if (f.min_duration_ms !== undefined) { where.push('t.duration_ms >= ?'); params.push(f.min_duration_ms); }
    if (f.max_duration_ms !== undefined) { where.push('t.duration_ms <= ?'); params.push(f.max_duration_ms); }
    if (f.from !== undefined) { where.push('t.finalized_at >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('t.finalized_at <= ?'); params.push(f.to); }
    if (f.trace_ids?.length) { where.push(`t.trace_id IN (${f.trace_ids.map(() => '?').join(', ')})`); params.push(...f.trace_ids); }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      where.push('(t.finalized_at < ? OR (t.finalized_at = ? AND t.trace_id < ?))');
      params.push(c.finalized_at, c.finalized_at, c.trace_id);
    }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const cols = SUMMARY_COLS.map((c) => 't.' + c).join(', ');
    const sql = `SELECT ${cols} FROM traces t ${join} WHERE ${where.join(' AND ')}
      ORDER BY t.finalized_at DESC, t.trace_id DESC LIMIT ?`;
    const rows = await this.db.all(sql, [...params, limit + 1]);
    const items = rows.slice(0, limit).map((r) => summary(r));
    const next_cursor = rows.length > limit ? encodeCursor(items[items.length - 1]) : null;
    return { items, next_cursor };
  }

  /** Summary search over archive_index (include_archived=true). */
  async queryArchived(projectId, f = {}, limit = 50) {
    const where = ['project_id = ?'];
    const params = [projectId];
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.reason) { where.push('sample_reason = ?'); params.push(f.reason); }
    if (f.service) { where.push('services LIKE ?'); params.push(`%,${f.service},%`); }
    if (f.min_duration_ms !== undefined) { where.push('duration_ms >= ?'); params.push(f.min_duration_ms); }
    if (f.max_duration_ms !== undefined) { where.push('duration_ms <= ?'); params.push(f.max_duration_ms); }
    if (f.from !== undefined) { where.push('finalized_at >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('finalized_at <= ?'); params.push(f.to); }
    const sql = `SELECT project_id, trace_id, status, sample_reason, duration_ms, root_service, finalized_at, object_key, archived_at
      FROM archive_index WHERE ${where.join(' AND ')} ORDER BY finalized_at DESC, trace_id DESC LIMIT ?`;
    return (await this.db.all(sql, [...params, Math.min(limit, 200)])).map((r) => ({ ...r, tier: 'cold' }));
  }

  /** Oldest hot rows finalized before cutoff (archive worker). */
  async selectAged(cutoff, limit, projectId) {
    if (projectId) {
      return this.db.all('SELECT * FROM traces WHERE project_id = ? AND finalized_at < ? ORDER BY finalized_at ASC LIMIT ?', [projectId, cutoff, limit]);
    }
    return this.db.all('SELECT * FROM traces WHERE finalized_at < ? ORDER BY finalized_at ASC LIMIT ?', [cutoff, limit]);
  }

  /** Index archived rows and delete them from hot in one transaction. */
  async markArchived(rows, objectKey, archivedAt, hooks = {}) {
    await this.db.tx(async (q) => {
      for (const r of rows) {
        const spans = JSON.parse(r.spans_json);
        const services = ',' + [...new Set(spans.map((s) => s.service))].sort().join(',') + ',';
        await q.run(
          `INSERT INTO archive_index (project_id, trace_id, object_key, archived_at, status, sample_reason, duration_ms, root_service, services, finalized_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (project_id, trace_id) DO UPDATE SET object_key = excluded.object_key, archived_at = excluded.archived_at,
             status = excluded.status, sample_reason = excluded.sample_reason, duration_ms = excluded.duration_ms,
             root_service = excluded.root_service, services = excluded.services, finalized_at = excluded.finalized_at`,
          [r.project_id, r.trace_id, objectKey, archivedAt, r.status, r.sample_reason, r.duration_ms, r.root_service, services, r.finalized_at],
        );
        if (hooks.beforeDelete) await hooks.beforeDelete(r);
        await q.run('DELETE FROM traces WHERE project_id = ? AND trace_id = ?', [r.project_id, r.trace_id]);
        await q.run('DELETE FROM trace_services WHERE project_id = ? AND trace_id = ?', [r.project_id, r.trace_id]);
      }
    });
  }

  /** Remove index rows for archive objects under a key prefix (cold retention purge). */
  async purgeArchivePrefix(prefix) {
    return this.db.run('DELETE FROM archive_index WHERE object_key LIKE ?', [prefix + '%']);
  }

  /** Distinct services seen in a project's hot traces (UI filter). */
  async services(projectId) {
    const rows = await this.db.all('SELECT DISTINCT service FROM trace_services WHERE project_id = ? ORDER BY service LIMIT 200', [projectId]);
    return rows.map((r) => r.service);
  }
}

module.exports = { TraceRepo, BadQuery, DEFAULT_PROJECT, rowToTrace };
