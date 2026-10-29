'use strict';
// SQLite adapter on Node's built-in node:sqlite (no native build step).
// Exposes the same async interface as the Postgres adapter so every repository is
// written once. All work goes through a FIFO lock so a transaction is never
// interleaved with another caller's statements on the single connection.
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
function loadDriver() {
  if (DatabaseSync) return DatabaseSync;
  // Silence the one-time ExperimentalWarning that Node 22 prints for node:sqlite.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => {
    const msg = typeof w === 'string' ? w : w?.message;
    if (/SQLite is an experimental feature/.test(msg || '')) return;
    return emit.call(process, w, ...rest);
  };
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } finally {
    process.emitWarning = emit;
  }
  return DatabaseSync;
}

function toParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

const plain = (row) => (row ? { ...row } : row);

class SqliteDb {
  constructor(file) {
    const Driver = loadDriver();
    this.dialect = 'sqlite';
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.raw = new Driver(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.stmts = new Map();
    this.lock = Promise.resolve();
    this.closed = false;
  }

  _stmt(sql) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  _exec(kind, sql, params = []) {
    if (this.closed) throw new Error('database is closed');
    const s = this._stmt(sql);
    const p = params.map(toParam);
    if (kind === 'all') return s.all(...p).map(plain);
    if (kind === 'get') return plain(s.get(...p));
    const r = s.run(...p);
    return { changes: Number(r.changes) };
  }

  /** Queue fn behind every earlier operation. */
  _locked(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.then(() => {}, () => {});
    return run;
  }

  all(sql, params) { return this._locked(() => this._exec('all', sql, params)); }
  get(sql, params) { return this._locked(() => this._exec('get', sql, params)); }
  run(sql, params) { return this._locked(() => this._exec('run', sql, params)); }

  exec(sql) {
    return this._locked(() => {
      if (this.closed) throw new Error('database is closed');
      this.raw.exec(sql);
    });
  }

  /**
   * Run fn(q) inside one transaction. q has all/get/run/exec bound to this
   * connection without re-taking the lock. Rolls back on any throw.
   */
  tx(fn) {
    return this._locked(async () => {
      if (this.closed) throw new Error('database is closed');
      const q = {
        dialect: 'sqlite',
        all: async (sql, params) => this._exec('all', sql, params),
        get: async (sql, params) => this._exec('get', sql, params),
        run: async (sql, params) => this._exec('run', sql, params),
        exec: async (sql) => this.raw.exec(sql),
      };
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(q);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.raw.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    });
  }

  async ping() {
    await this.get('SELECT 1 AS ok');
  }

  async checkpoint() {
    try { await this.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
  }

  async close() {
    await this._locked(() => {
      if (this.closed) return;
      this.closed = true;
      this.stmts.clear();
      this.raw.close();
    });
  }
}

module.exports = { SqliteDb };
