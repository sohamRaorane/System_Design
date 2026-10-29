'use strict';
// Open SQLite (WAL) and run migrations (section 4.4).
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const MIGRATIONS = [
  `
CREATE TABLE traces (
  trace_id        TEXT PRIMARY KEY,
  status          TEXT NOT NULL,
  sample_reason   TEXT NOT NULL,
  is_complete     INTEGER NOT NULL,
  root_service    TEXT,
  root_operation  TEXT,
  duration_ms     INTEGER NOT NULL,
  span_count      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  finalized_at    INTEGER NOT NULL,
  stored_at       INTEGER NOT NULL,
  spans_json      TEXT NOT NULL
);
CREATE TABLE trace_services (
  trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
  service  TEXT NOT NULL,
  PRIMARY KEY (trace_id, service)
);
CREATE TABLE archive_index (
  trace_id    TEXT PRIMARY KEY,
  file_path   TEXT NOT NULL,
  archived_at INTEGER NOT NULL,
  status      TEXT, duration_ms INTEGER, root_service TEXT, finalized_at INTEGER
);
CREATE INDEX idx_traces_status_fin ON traces(status, finalized_at DESC);
CREATE INDEX idx_traces_fin        ON traces(finalized_at DESC);
CREATE INDEX idx_traces_duration   ON traces(duration_ms DESC);
CREATE INDEX idx_traces_root_svc   ON traces(root_service, finalized_at DESC);
CREATE INDEX idx_svc_service       ON trace_services(service, trace_id);
`,
];

function openDb(dbPath) {
  try {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
    let current = row.v || 0;
    for (; current < MIGRATIONS.length; current++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[current]);
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(current + 1);
      })();
    }
    db.prepare('SELECT COUNT(*) FROM traces').get(); // corrupt-file smoke check
    return db;
  } catch (err) {
    // E44: fail fast with a clear message.
    const e = new Error(`cannot open database at ${dbPath}: ${err.message}. Run "npm run reset" for a clean state.`);
    e.cause = err;
    throw e;
  }
}

module.exports = { openDb };
