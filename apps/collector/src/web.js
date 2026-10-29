'use strict';
// Optionally serve the built dashboard (apps/web/dist) from the collector itself, so the
// whole product can run as one service. Set WEB_DIST to the dist folder to enable.
// API paths are never shadowed; every other GET falls back to index.html (SPA routing).
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const API_PREFIXES = ['/v1/', '/api/', '/metrics', '/health', '/.well-known/'];

function webRouter(distDir) {
  const router = express.Router();
  const dir = path.resolve(distDir);
  const index = path.join(dir, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`WEB_DIST=${distDir} has no index.html (run npm run build -w @system-design/web)`);
  router.use(express.static(dir, {
    setHeaders(res, file) {
      // Vite fingerprints assets, so they can be cached forever; index.html must not be.
      res.setHeader('Cache-Control', file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  }));
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (API_PREFIXES.some((p) => req.path === p.replace(/\/$/, '') || req.path.startsWith(p))) return next();
    if (!String(req.get('accept') || '').includes('text/html')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(index);
  });
  return router;
}

module.exports = { webRouter };
