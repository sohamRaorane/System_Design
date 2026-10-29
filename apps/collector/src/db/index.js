'use strict';
// Opens the configured database and brings its schema up to date.
//   DATABASE_URL=postgres://...  -> Postgres (cloud)
//   otherwise                    -> SQLite file at dbPath (local development, tests)
const { SqliteDb } = require('./sqlite');
const { migrate } = require('./migrations');

async function openDatabase({ databaseUrl, dbPath = 'data/telemetry.db', logger } = {}) {
  let db;
  try {
    if (databaseUrl) {
      const { PostgresDb } = require('./postgres');
      db = new PostgresDb(databaseUrl);
    } else {
      db = new SqliteDb(dbPath);
    }
    await migrate(db, { logger });
    return db;
  } catch (err) {
    try { await db?.close(); } catch { /* ignore */ }
    const where = databaseUrl ? 'Postgres (DATABASE_URL)' : dbPath;
    const e = new Error(`cannot open database at ${where}: ${err.message}`);
    e.cause = err;
    throw e;
  }
}

module.exports = { openDatabase };
