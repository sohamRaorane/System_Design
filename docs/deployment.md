# Deploying Tracepipe (Render + Vercel + Neon + R2)

Everything below fits the free tiers. Do the steps in order: later steps need values from
earlier ones. Time: about 45 minutes the first time.

```
Browser ──► Vercel (dashboard) ──/api/* rewrite──► Render: tracepipe-collector
Your apps ──OTLP + x-api-key─────────────────────► Render: tracepipe-collector
tracepipe-collector ──► Neon Postgres (data)   ──► Cloudflare R2 (cold archive)
                    ──► GitHub (sign-in, pull requests)
```

## 0. Generate secrets

```bash
npm run secrets
```

Keep the output: `JWT_PRIVATE_KEY` signs sign-in tokens. Render generates `ADMIN_TOKEN` for
you, so you can ignore the one printed here unless you deploy somewhere else.

## 1. Database: Neon

1. Create a project at neon.tech, region **AWS Asia Pacific (Singapore)** (same region as Render).
2. Copy the connection string (it ends in `?sslmode=require`). This is `DATABASE_URL`.

Tables are created automatically on first start.

## 2. Cold archive: Cloudflare R2 (optional, recommended)

1. Cloudflare dashboard → R2 → create a bucket, e.g. `tracepipe-archive`.
2. R2 → Manage API tokens → create a token with **Object Read & Write** on that bucket.
3. Note: `R2_ACCOUNT_ID` (shown on the R2 overview), `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

Without R2 the archive goes to local disk, which Render wipes on every restart.

## 3. Deploy the collector on Render

1. Render → **New → Blueprint** → choose this repository. It reads `render.yaml`.
2. Fill the values marked `sync: false` (GitHub values come in step 5; leave them empty for now).
3. Deploy. Check `https://tracepipe-collector.onrender.com/livez` returns `{"status":"alive"}`.
   If Render gave the service a different URL, use that URL everywhere below.

The collector refuses to start in production without `DATABASE_URL`, `JWT_PRIVATE_KEY`,
`ADMIN_TOKEN`, `WEB_ORIGIN` and the GitHub sign-in values: the log says exactly which is missing.

## 4. Deploy the dashboard on Vercel

1. If your collector URL is not `https://tracepipe-collector.onrender.com`, edit the `/api`
   destination in `apps/web/vercel.json` and push.
2. Vercel → **Add New Project** → import the repository → **Root Directory: `apps/web`**.
   Framework: Vite (detected). Deploy.
3. Your dashboard URL (e.g. `https://tracepipe.vercel.app`) is `WEB_ORIGIN`. Set it on the
   Render collector.

## 5. GitHub App (sign-in + repository access)

GitHub → Settings → Developer settings → **GitHub Apps → New GitHub App**:

| Field | Value |
|---|---|
| GitHub App name | e.g. `Tracepipe Group21` (its slug becomes `GITHUB_APP_SLUG`) |
| Homepage URL | your Vercel URL |
| Callback URL | `https://<your-vercel-app>/api/auth/github/callback` |
| Expire user authorization tokens | **unchecked** (otherwise repo lists need a fresh sign-in every 8 hours) |
| Request user authorization (OAuth) during installation | unchecked |
| Setup URL | `https://<your-vercel-app>/api/github/setup`, with **Redirect on update** checked |
| Webhook | **Active: unchecked** (not used) |
| Repository permissions | **Contents: Read and write**, **Pull requests: Read and write**, Metadata: Read-only |
| Account permissions | none (email not needed) |
| Where can this app be installed | Any account (or only yours while testing) |

After creating it:

- `GITHUB_APP_ID`: the App ID on the app's page
- `GITHUB_CLIENT_ID`: the Client ID; **Generate a new client secret** → `GITHUB_CLIENT_SECRET`
- **Generate a private key** (downloads a `.pem`) → `GITHUB_APP_PRIVATE_KEY`. Paste the whole
  file; on one line with `\n` escapes is fine.
- `GITHUB_APP_SLUG`: the last part of the app's public URL `github.com/apps/<slug>`

Set all five on the Render collector, plus `ADMIN_GITHUB_LOGINS=<your-github-login>`.
Render redeploys automatically.

## 6. First run

1. Open the Vercel URL → **Sign in with GitHub**.
2. **New project** → copy the ingest key.
3. Either **Choose a repository** (opens a pull request in your app), or deploy the demo shop:
   on Render's `tracepipe-demo-shop` service set
   `OTEL_EXPORTER_OTLP_ENDPOINT=https://tracepipe-collector.onrender.com` and
   `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<the key>`.
4. Open your app (or the demo shop's `/api/products`) a few times. The project's overview
   turns from "waiting for the first trace" to live within a few seconds.
5. **Load test** → enter your app's URL → **Check access** → start.

## Free-tier behaviour to expect

- **Render** sleeps the collector after 15 minutes without traffic; the first request then
  takes about a minute (the dashboard says so). Spans sent while it sleeps are lost, as are
  traces still being assembled at that moment. 750 free hours a month cover one always-busy service.
- **Neon** suspends compute after 5 minutes idle; the first query after that is slower.
  1 GB per project: keep hot retention short (Settings → keep traces searchable for 2–7 days).
- **R2** free tier: 10 GB-month, no egress fees.

## Operating

| Task | How |
|---|---|
| Pipeline health | `GET /health` (detailed), `GET /metrics` with `X-Admin-Token` |
| Change sampling/limits globally | Dashboard **Admin** page, or `PUT /v1/config` with `X-Admin-Token` |
| Failure drills | Dashboard **Admin** page, or `PUT /v1/faults` |
| Rotate the JWT key | set the old public key in `JWT_PREVIOUS_PUBLIC_KEYS`, put the new private key in `JWT_PRIVATE_KEY`, redeploy; remove the old key after 15 minutes |
| Revoke an ingest key | project **Settings → Ingest keys → Revoke** (immediate) |
