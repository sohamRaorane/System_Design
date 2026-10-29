'use strict';
// Hot-tier storage and queries (section 5.7), with merge-on-write (E46).
const { buildTrace } = require('../aggregate/traceBuilder');
const { REASON_PRIORITY } = require('../sample/sampler');

const SUMMARY_COLS =
  'trace_id, status, sample_reason, is_complete, root_service, root_operation, duration_ms, span_count, created_at, finalized_at, stored_at';

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
  return { ...rest, is_complete: Boolean(row.is_complete), spans, services: [...new Set(spans.map((s) => s.service))].sort() };
}

class TraceRepo {
  constructor({ db, faults, clock, metrics }) {
    this.db = db;
    this.faults = faults;
    this.clock = clock;
    this.metrics = metrics;
    this.stmts = {
      get: db.prepare('SELECT * FROM traces WHERE trace_id = ?'),
      upsert: db.prepare(`INSERT OR REPLACE INTO traces (${SUMMARY_COLS}, spans_json)
        VALUES (@trace_id, @status, @sample_reason, @is_complete, @root_service, @root_operation, @duration_ms, @span_count, @created_at, @finalized_at, @stored_at, @spans_json)`),
      delSvc: db.prepare('DELETE FROM trace_services WHERE trace_id = ?'),
      svc: db.prepare('INSERT OR IGNORE INTO trace_services (trace_id, service) VALUES (?, ?)'),
      countHot: db.prepare('SELECT COUNT(*) AS n FROM traces'),
      countCold: db.prepare('SELECT COUNT(*) AS n FROM archive_index'),
      archived: db.prepare('SELECT * FROM archive_index WHERE trace_id = ?'),
    };
    this.insertTx = db.transaction((traces, storedAt) => {
      for (const t of traces) this._upsert(t, storedAt);
    });
  }

  _upsert(incoming, storedAt) {
    const existingRow = this.stmts.get.get(incoming.trace_id);
    let t = incoming;
    if (existingRow) {
      // Merge-on-write: union spans by span_id, recompute derived fields, keep the higher-priority reason.
      const existing = rowToTrace(existingRow);
      const byId = new Map(existing.spans.map((s) => [s.span_id, s]));
      for (const s of incoming.spans) if (!byId.has(s.span_id)) byId.set(s.span_id, s);
      const root = [...byId.values()].find((s) => !s.parent_span_id);
      const merged = buildTrace([...byId.values()], {
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
    this.stmts.upsert.run({
      trace_id: t.trace_id,
      status: t.status,
      sample_reason: t.sample_reason,
      is_complete: t.is_complete ? 1 : 0,
      root_service: t.root_service,
      root_operation: t.root_operation,
      duration_ms: t.duration_ms,
      span_count: t.span_count,
      created_at: t.created_at,
      finalized_at: t.finalized_at,
      stored_at: storedAt,
      spans_json: JSON.stringify(t.spans),
    });
    this.stmts.delSvc.run(t.trace_id);
    for (const s of new Set(t.spans.map((x) => x.service))) this.stmts.svc.run(t.trace_id, s);
  }

  /** One transaction for the whole batch; throws if storage_down. Returns stored_at. */
  insertBatch(traces) {
    if (this.faults.get('storage_down')) throw new Error('storage unavailable (injected fault)');
    const storedAt = this.clock.now();
    this.insertTx(traces, storedAt);
    return storedAt;
  }

  getHot(id) {
    const row = this.stmts.get.get(id);
    return row ? rowToTrace(row) : null;
  }

  getArchiveEntry(id) {
    return this.stmts.archived.get(id) || null;
  }

  safeCount(tier) {
    try {
      return (tier === 'hot' ? this.stmts.countHot : this.stmts.countCold).get().n;
    } catch {
      return null;
    }
  }

  ping() {
    this.db.prepare('SELECT 1').get();
  }

  query(f = {}) {
    const where = [];
    const params = [];
    const join = f.service ? 'JOIN trace_services ts ON ts.trace_id = t.trace_id' : '';
    if (f.service) { where.push('ts.service = ?'); params.push(f.service); }
    if (f.status) { where.push('t.status = ?'); params.push(f.status); }
    if (f.reason) { where.push('t.sample_reason = ?'); params.push(f.reason); }
    if (f.min_duration_ms !== undefined) { where.push('t.duration_ms >= ?'); params.push(f.min_duration_ms); }
    if (f.max_duration_ms !== undefined) { where.push('t.duration_ms <= ?'); params.push(f.max_duration_ms); }
    if (f.from !== undefined) { where.push('t.finalized_at >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('t.finalized_at <= ?'); params.push(f.to); }
    if (f.cursor) {
      const c = decodeCursor(f.cursor);
      where.push('(t.finalized_at < ? OR (t.finalized_at = ? AND t.trace_id < ?))');
      params.push(c.finalized_at, c.finalized_at, c.trace_id);
    }
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
    const cols = SUMMARY_COLS.split(', ').map((c) => 't.' + c).join(', ');
    const sql = `SELECT ${cols} FROM traces t ${join} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY t.finalized_at DESC, t.trace_id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit + 1);
    const items = rows.slice(0, limit).map((r) => ({ ...r, is_complete: Boolean(r.is_complete), tier: 'hot' }));
    const next_cursor = rows.length > limit ? encodeCursor(items[items.length - 1]) : null;
    return { items, next_cursor };
  }

  /** Summary search over archive_index (include_archived=true). */
  queryArchived(f = {}, limit = 50) {
    const where = [];
    const params = [];
    if (f.status) { where.push('status = ?'); params.push(f.status); }
    if (f.service) { where.push('root_service = ?'); params.push(f.service); }
    if (f.min_duration_ms !== undefined) { where.push('duration_ms >= ?'); params.push(f.min_duration_ms); }
    if (f.max_duration_ms !== undefined) { where.push('duration_ms <= ?'); params.push(f.max_duration_ms); }
    if (f.from !== undefined) { where.push('finalized_at >= ?'); params.push(f.from); }
    if (f.to !== undefined) { where.push('finalized_at <= ?'); params.push(f.to); }
    const sql = `SELECT trace_id, status, duration_ms, root_service, finalized_at, file_path, archived_at FROM archive_index
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY finalized_at DESC, trace_id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...params, Math.min(limit, 200)).map((r) => ({ ...r, tier: 'cold' }));
  }
}

module.exports = { TraceRepo, BadQuery };
