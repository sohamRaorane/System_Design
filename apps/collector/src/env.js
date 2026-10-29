'use strict';
// Reads and checks process.env once. Production refuses to start with unsafe settings
// instead of running half-configured.

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v)));
const list = (v) => String(v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const trimSlash = (v) => (v ? String(v).replace(/\/+$/, '') : v);
/** Render and other dashboards store multi-line PEM keys with literal "\n"; restore them. */
const pem = (v) => (v ? String(v).replace(/\\n/g, '\n').trim() : undefined);

function readEnv(e = process.env) {
  const production = e.NODE_ENV === 'production';
  const port = Number(e.PORT || 4318);
  const env = {
    production,
    port,
    logLevel: e.LOG_LEVEL || 'info',
    databaseUrl: e.DATABASE_URL || undefined,
    // optional: keep this app's tables in their own Postgres schema (shared databases, tests)
    pgSchema: e.PG_SCHEMA || undefined,
    dbPath: e.DB_PATH || 'data/telemetry.db',
    coldDir: e.COLD_DIR || 'cold',
    configPath: e.CONFIG_PATH || undefined,
    webDist: e.WEB_DIST || undefined,
    // Public URL of this collector (OTLP endpoint shown to users) and of the dashboard.
    publicUrl: trimSlash(e.PUBLIC_URL || e.RENDER_EXTERNAL_URL) || `http://localhost:${port}`,
    webOrigin: trimSlash(e.WEB_ORIGIN) || (production ? undefined : 'http://localhost:5173'),
    adminToken: e.ADMIN_TOKEN || '',
    adminLogins: list(e.ADMIN_GITHUB_LOGINS),
    jwtPrivateKey: pem(e.JWT_PRIVATE_KEY),
    jwtPreviousPublicKeys: (e.JWT_PREVIOUS_PUBLIC_KEYS ? String(e.JWT_PREVIOUS_PUBLIC_KEYS).split('|||').map(pem) : []),
    devLogin: bool(e.DEV_LOGIN, false) && !production,
    allowAnonymousIngest: bool(e.ALLOW_ANONYMOUS_INGEST, !production),
    cookieSecure: bool(e.COOKIE_SECURE, production),
    github: {
      clientId: e.GITHUB_CLIENT_ID || '',
      clientSecret: e.GITHUB_CLIENT_SECRET || '',
      appId: e.GITHUB_APP_ID || '',
      appSlug: e.GITHUB_APP_SLUG || '',
      appPrivateKey: pem(e.GITHUB_APP_PRIVATE_KEY),
      apiUrl: trimSlash(e.GITHUB_API_URL) || 'https://api.github.com',
      webUrl: trimSlash(e.GITHUB_WEB_URL) || 'https://github.com',
    },
    s3: {
      endpoint: trimSlash(e.S3_ENDPOINT || (e.R2_ACCOUNT_ID ? `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '')),
      region: e.S3_REGION || 'auto',
      bucket: e.S3_BUCKET || e.R2_BUCKET || '',
      accessKeyId: e.S3_ACCESS_KEY_ID || e.R2_ACCESS_KEY_ID || '',
      secretAccessKey: e.S3_SECRET_ACCESS_KEY || e.R2_SECRET_ACCESS_KEY || '',
      prefix: e.S3_PREFIX || 'archive/',
    },
    loadtest: {
      allowPrivateTargets: bool(e.LOADTEST_ALLOW_PRIVATE_TARGETS, !production),
      maxRps: Number(e.LOADTEST_MAX_RPS || 50),
      maxDurationS: Number(e.LOADTEST_MAX_DURATION_S || 120),
    },
  };
  env.githubEnabled = Boolean(env.github.clientId && env.github.clientSecret);
  env.githubAppEnabled = Boolean(env.github.appId && env.github.appPrivateKey);
  env.s3Enabled = Boolean(env.s3.endpoint && env.s3.bucket && env.s3.accessKeyId && env.s3.secretAccessKey);
  return env;
}

/** Problems that make a production start unsafe. Empty in development. */
function productionProblems(env) {
  if (!env.production) return [];
  const p = [];
  if (!env.databaseUrl) p.push('DATABASE_URL is required in production (the local disk is wiped on every Render restart).');
  if (!env.jwtPrivateKey) p.push('JWT_PRIVATE_KEY is required in production (an RSA private key in PEM format).');
  if (!env.adminToken || env.adminToken.length < 24) p.push('ADMIN_TOKEN must be set to a random value of at least 24 characters.');
  if (!env.webOrigin) p.push('WEB_ORIGIN is required in production (the dashboard URL, e.g. https://your-app.vercel.app).');
  if (!env.githubEnabled) p.push('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required in production (sign-in).');
  return p;
}

module.exports = { readEnv, productionProblems };
