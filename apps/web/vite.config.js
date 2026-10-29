import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the dashboard and the collector run on different ports; the proxy makes
// every API call same-origin, exactly like the Vercel /api rewrite does in production.
const collector = process.env.COLLECTOR_URL || 'http://localhost:4318';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': collector,
      '/v1': collector,
      '/metrics': collector,
      '/health': collector,
      '/.well-known': collector,
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
