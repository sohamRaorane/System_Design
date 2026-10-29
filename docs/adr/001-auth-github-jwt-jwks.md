# ADR-001: Sign in with GitHub, issue our own JWT (RS256), publish JWKS

- Status: Accepted (2026-10-29)

## Context
Users must sign in with GitHub, and the product needs ongoing access to their repositories to
open an instrumentation pull request. Options considered: Firebase Authentication (GitHub
provider), or GitHub OAuth handled by our backend.

## Decision
- **Sign-in:** GitHub OAuth (user-to-server flow of our GitHub App) handled by the collector.
- **Session:** the collector issues a short-lived access JWT (RS256, ~15 min) and a rotating
  refresh token in an `httpOnly; Secure; SameSite=Lax` cookie.
- **Verification:** public keys published at `/.well-known/jwks.json` (library: `jose`), so any
  future service can verify tokens without sharing a secret. Key rotation = add a new `kid`.
- **Repository access:** a GitHub App installed on selected repos (fine-grained, short-lived
  installation tokens), not an OAuth `repo` scope.
- **Ingest auth:** per-project API keys (stored hashed), separate from user JWTs.
- **Cookies:** the frontend calls `/api/*` on its own Vercel origin, rewritten to Render, so the
  refresh cookie is first-party and not blocked as a third-party cookie.

## Consequences
- Firebase was rejected: it returns the GitHub access token only once at sign-in and does not
  store or refresh it, so we would still need our own token handling plus a second vendor.
- We own key management: the private key lives only in Render env vars.
