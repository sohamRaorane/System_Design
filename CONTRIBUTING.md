# Contributing

## Branches
- `main` — production. Protected; only merged from `dev` at a phase gate; each gate is tagged
  (`v0.1.0` = Phase 0, `v0.2.0` = Phase 1, … `v1.0.0` = Phase 7).
- `dev` — integration; Vercel preview deploys from here.
- Work branches from `dev`: `feat/p<phase>-<topic>`, `fix/p<phase>-<topic>`, `chore/…`,
  `docs/…`. Hotfixes: `hotfix/<topic>` from `main`, merged into `main` and `dev`.
- Feature branches are **squash-merged** into `dev`; `dev` is merged into `main` with a
  merge commit at each gate.

## Commit messages (Conventional Commits)
```
<type>(<scope>): <imperative summary, max 72 chars>

<why: the problem this solves, not how>

Refs: #<issue>
BREAKING CHANGE: <only if applicable>
```
Types: `feat` `fix` `refactor` `perf` `test` `docs` `chore` `ci` `build`.
Scopes: `collector` `ingest` `aggregate` `sample` `batch` `store` `archive` `auth` `projects`
`github` `loadtest` `web` `demo` `infra`.

Every commit must build and pass `npm test`, so any commit is a safe rollback point.

## Phase gates
At the end of each phase: open a PR `dev → main`, attach the gate demo checklist from
`docs/architecture.md`, get sign-off, merge, tag.

## Local setup
```bash
nvm use            # Node 22 (see .nvmrc)
npm install
cp .env.example .env
npm test
npm start
```
Keep the repository **outside** OneDrive/Dropbox-synced folders; sync clients lock `.git` and
`node_modules` files.
