# ADR-004: Built-in modules over packages where the gain is small

- Status: Accepted (2026-10-29)

## Context
The build environment used to write this code had no access to the npm registry, and every
dependency is also something to patch, audit and install on Render/Vercel. ADR-001 and the
approved stack named `jose`, TanStack Query, Tailwind/shadcn and Recharts.

## Decision
- **SQLite:** Node's built-in `node:sqlite` instead of `better-sqlite3` (no native build;
  requires Node 22.13+).
- **OTLP protobuf:** a ~200-line decoder for the trace messages, verified against a fixture
  encoded by Google's protobuf library, instead of `protobufjs` + generated code.
- **JWT/JWKS (Phase 2):** RS256 with `node:crypto` (sign, verify, JWK export), instead of `jose`.
- **Dashboard:** React + Vite only; a 60-line router, a polling hook, plain CSS with design
  tokens, and SVG/CSS charts instead of React Router, TanStack Query, Tailwind and Recharts.
- Remaining runtime dependencies: `express` (collector), `pg` (Phase 5), `react`, `react-dom`.

## Consequences
- Fewer moving parts and a much smaller install; the code that replaces each package is small
  and covered by tests.
- We own a little more code (router, protobuf decoder, JWT). If the dashboard grows large,
  adopting React Router / TanStack Query later is a mechanical change.
