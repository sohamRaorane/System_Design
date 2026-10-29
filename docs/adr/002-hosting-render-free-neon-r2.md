# ADR-002: Render Free (collector) + Vercel (web) + Neon Postgres + Cloudflare R2

- Status: Accepted (2026-10-29)

## Decision
| Concern | Choice |
|---|---|
| Collector | Render **Free** web service (single instance) |
| Frontend | Vercel (static Vite build, `/api/*` rewrite to Render) |
| Hot store + app data | Neon Postgres Free (does not expire; 1 GB per project) |
| Cold archive + spill | Cloudflare R2 (S3 API; 10 GB-month free, no egress fees) |
| Local development | SQLite + local `cold/` folder (unchanged) |

## Consequences (accepted trade-offs of the free tier)
- Render Free spins down after 15 min without inbound traffic and takes about a minute to wake.
  Telemetry sent while it sleeps is lost, and traces still being assembled in memory at
  spin-down are lost. Acceptable for a demo/academic deployment; documented in the UI.
- Render Free's filesystem is ephemeral, so nothing durable may be written to local disk in
  production: hot data goes to Neon, archive and spill to R2.
- Render Free Postgres was rejected because it expires 30 days after creation.
- One collector instance only (see architecture gap G7).
- Neon Free suspends compute after 5 min idle; the first query after idle is slower. Keep hot
  retention short (default 2 days in production) and archive to R2 early to stay under 1 GB.
