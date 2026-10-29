'use strict';
// Postgres adapter (cloud: Neon, Render Postgres, any Postgres 13+), same async interface as
// the SQLite adapter. Repository SQL is written with `?` placeholders; they are rewritten to
// $1..$n here. BIGINT/COUNT values come back as JS numbers (all of ours fit in 2^53).
const { Pool, types } = require('pg');

types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // int8 / BIGINT / COUNT(*)
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric

/** Rewrite `?` placeholders to $n, leaving quoted strings and identifiers alone. */
function toPositional(sql) {
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) { out += sql[++i]; } else quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    out += ch === '?' ? `$${++n}` : ch;
  }
  return out;
}

const toParam = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
const SCHEMA_RE = /^[a-z_][a-z0-9_]{0,62}$/;

class PostgresDb {
  /**
   * @param {string} url  postgres://user:pass@host/db?sslmode=require
   * @param {object} [o]
   * @param {string} [o.schema]  use (and create) a dedicated schema, e.g. for isolated tests
   */
  constructor(url, { schema, max = Number(process.env.PG_POOL_MAX || 5) } = {}) {
    this.dialect = 'postgres';
    this.closed = false;
    this.schema = schema;
    if (schema && !SCHEMA_RE.test(schema)) throw new Error('invalid schema name');
    this.pool = new Pool({ connectionString: url, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    // A dropped idle connection (Neon scales to zero) must not crash the process.
    this.pool.on('error', () => {});
    if (schema) this.pool.on('connect', (client) => { client.query(`SET search_path TO "${schema}"`).catch(() => {}); });
    this.ready = schema ? this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`) : Promise.resolve();
  }

  async _q(runner, sql, params = []) {
    if (this.closed) throw new Error('database is closed');
    await this.ready;
    return runner.query(toPositional(sql), params.map(toParam));
  }

  async all(sql, params) { return (await this._q(this.pool, sql, params)).rows; }
  async get(sql, params) { return (await this._q(this.pool, sql, params)).rows[0]; }
  async run(sql, params) { return { changes: (await this._q(this.pool, sql, params)).rowCount || 0 }; }

  async exec(sql) {
    if (this.closed) throw new Error('database is closed');
    await this.ready;
    await this.pool.query(sql);
  }

  async tx(fn) {
    if (this.closed) throw new Error('database is closed');
    await this.ready;
    const client = await this.pool.connect();
    const q = {
      dialect: 'postgres',
      all: async (sql, params) => (await client.query(toPositional(sql), (params || []).map(toParam))).rows,
      get: async (sql, params) => (await client.query(toPositional(sql), (params || []).map(toParam))).rows[0],
      run: async (sql, params) => ({ changes: (await client.query(toPositional(sql), (params || []).map(toParam))).rowCount || 0 }),
      exec: async (sql) => { await client.query(sql); },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(q);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    } finally {
      client.release();
    }
  }

  async ping() {
    await this.get('SELECT 1 AS ok');
  }

  async checkpoint() { /* Postgres manages its own WAL */ }

  /** Tests: remove the dedicated schema. */
  async dropSchema() {
    if (this.schema) await this.pool.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

module.exports = { PostgresDb, toPositional };
