'use strict';
// Ordered, append-only schema migrations. Each entry is a function of the dialect so the
// same schema runs on SQLite (local) and Postgres (cloud). Never edit a released entry:
// add a new one.

const T = (dialect) => ({
  big: dialect === 'postgres' ? 'BIGINT' : 'INTEGER',
  int: 'INTEGER',
  text: 'TEXT',
});

const MIGRATIONS = [
  {
    name: '001_traces',
    sql: (d) => {
      const t = T(d);
      return `
CREATE TABLE traces (
  project_id      TEXT NOT NULL,
  trace_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  sample_reason   TEXT NOT NULL,
  is_complete     ${t.int} NOT NULL,
  root_service    TEXT,
  root_operation  TEXT,
  duration_ms     ${t.big} NOT NULL,
  span_count      ${t.int} NOT NULL,
  created_at      ${t.big} NOT NULL,
  finalized_at    ${t.big} NOT NULL,
  stored_at       ${t.big} NOT NULL,
  spans_json      TEXT NOT NULL,
  PRIMARY KEY (project_id, trace_id)
);
CREATE TABLE trace_services (
  project_id TEXT NOT NULL,
  trace_id   TEXT NOT NULL,
  service    TEXT NOT NULL,
  PRIMARY KEY (project_id, trace_id, service)
);
CREATE TABLE archive_index (
  project_id   TEXT NOT NULL,
  trace_id     TEXT NOT NULL,
  object_key   TEXT NOT NULL,
  archived_at  ${t.big} NOT NULL,
  status       TEXT,
  sample_reason TEXT,
  duration_ms  ${t.big},
  root_service TEXT,
  services     TEXT,
  finalized_at ${t.big},
  PRIMARY KEY (project_id, trace_id)
);
CREATE INDEX idx_traces_proj_fin    ON traces (project_id, finalized_at DESC, trace_id DESC);
CREATE INDEX idx_traces_proj_status ON traces (project_id, status, finalized_at DESC);
CREATE INDEX idx_traces_proj_reason ON traces (project_id, sample_reason, finalized_at DESC);
CREATE INDEX idx_traces_fin         ON traces (finalized_at);
CREATE INDEX idx_svc_service        ON trace_services (project_id, service, trace_id);
CREATE INDEX idx_archive_proj_fin   ON archive_index (project_id, finalized_at DESC);
CREATE INDEX idx_archive_key        ON archive_index (object_key);
`;
    },
  },
  {
    name: '002_accounts',
    sql: (d) => {
      const t = T(d);
      return `
CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  github_id     ${t.big} UNIQUE,
  login         TEXT NOT NULL,
  name          TEXT,
  avatar_url    TEXT,
  github_token  TEXT,
  created_at    ${t.big} NOT NULL,
  last_login_at ${t.big} NOT NULL
);
CREATE UNIQUE INDEX idx_users_login ON users (login);
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_at  ${t.big} NOT NULL,
  expires_at  ${t.big} NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
`;
    },
  },
];

/** Split a multi-statement DDL string into single statements (no semicolons inside strings). */
function statements(sql) {
  return sql.split(';').map((s) => s.trim()).filter(Boolean);
}

async function migrate(db, { logger } = {}) {
  const legacy = await tableExists(db, 'schema_version');
  const tracked = await tableExists(db, 'schema_migrations');
  if (legacy && !tracked) {
    throw new Error('this database was created by the pre-monorepo collector and has an incompatible schema. Run "npm run reset" (local data only) and start again.');
  }
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const m of MIGRATIONS) {
    if (done.has(m.name)) continue;
    await db.tx(async (q) => {
      for (const stmt of statements(m.sql(db.dialect))) await q.exec(stmt);
      await q.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', [m.name, new Date().toISOString()]);
    });
    logger?.info?.(`migration applied: ${m.name}`);
  }
}

async function tableExists(db, name) {
  if (db.dialect === 'postgres') {
    const r = await db.get('SELECT to_regclass(?) AS t', [name]);
    return Boolean(r && r.t);
  }
  const r = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
  return Boolean(r);
}

module.exports = { MIGRATIONS, migrate, statements };
