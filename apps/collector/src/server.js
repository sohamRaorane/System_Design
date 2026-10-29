'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { readEnv, productionProblems } = require('./env');
const { createLogger } = require('./util/common');

async function main() {
  const env = readEnv();
  const logger = createLogger(env.logLevel);
  const problems = productionProblems(env);
  if (problems.length) {
    for (const p of problems) logger.error('config: ' + p);
    throw new Error('refusing to start in production with an unsafe configuration (see the lines above)');
  }
  const configPath = env.configPath || path.join(__dirname, '..', 'config', 'default.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const { app, ctx } = await createApp({ env, config, logger });
  ctx.start();
  const server = app.listen(env.port, () => logger.info(`collector listening on :${env.port} (db=${env.databaseUrl ? 'postgres' : env.dbPath}, public=${env.publicUrl})`));
  // Long-lived OTLP keep-alive connections from SDKs: stay above typical proxy idle timeouts.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${sig} received, shutting down`);
    const force = setTimeout(() => process.exit(1), 25000);
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

main().catch((err) => {
  console.error(`[${new Date().toISOString()}] ERROR ${err.message}`);
  process.exit(1);
});
