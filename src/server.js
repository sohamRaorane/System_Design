'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { createLogger } = require('./util/common');

const PORT = Number(process.env.PORT || 4318);
const DB_PATH = process.env.DB_PATH || 'data/telemetry.db';
const COLD_DIR = process.env.COLD_DIR || 'cold';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '..', 'config', 'default.json');
const logger = createLogger(process.env.LOG_LEVEL || 'info');

function main() {
  let config = {};
  if (fs.existsSync(CONFIG_PATH)) config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const { app, ctx } = createApp({ config, dbPath: DB_PATH, coldDir: COLD_DIR, logger });
  ctx.start();
  const server = app.listen(PORT, () => logger.info(`collector listening on http://localhost:${PORT} (db=${DB_PATH}, cold=${COLD_DIR})`));

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${sig} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 10000);
    server.close();
    server.closeIdleConnections?.();
    try {
      const clean = await ctx.shutdown();
      logger.info(`shutdown complete (all batches stored: ${clean})`);
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

try {
  main();
} catch (err) {
  logger.error(err.message);
  process.exit(1);
}
