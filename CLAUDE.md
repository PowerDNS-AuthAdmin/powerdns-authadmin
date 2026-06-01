# CLAUDE.md

Guidance for AI coding agents working in this repository. This file is read before any task.

## What this repository is

**PowerDNS-AuthAdmin** - a self-hosted DNS administration UI for PowerDNS Authoritative. The app
manages one or many PDNS backends (standalone primaries, primary + secondaries groups, multi-
primary clusters) from a single web app with RBAC, OIDC SSO, audit log, and YAML-driven
provisioning.

The stack is Next.js 16 (App Router + RSC) on Node 24, TypeScript strict mode, Drizzle ORM
over Postgres or SQLite, CASL for RBAC, Argon2id for passwords, openid-client for OIDC,
better-sqlite3 / pg for storage.

Licensed under **MIT**.

## Start here

1. **[`README.md`](./README.md)** - public-facing overview + feature list + quickstart.
2. **[`docs/FEATURES.md`](./docs/FEATURES.md)** - exhaustive feature catalog with module pointers.
3. **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** - code standards, testing, security, perf budgets.
   Enforced by ESLint + CI; following these rules saves review churn.
4. **[`docs/adr/`](./docs/adr/)** - Architecture Decision Records. Read the relevant ADR before
   changing anything load-bearing (auth, RBAC, PDNS client, sessions, migrations).
5. **[`docs/dev-setup.md`](./docs/dev-setup.md)** - local development workflow.

## How to run things

### Containerized demo (quickest)

```sh
docker compose up -d   # demo stack (app + PDNS); reads throwaway secrets from .env.example
#   app  at http://localhost:3000          (login: admin@example.com / change-me-now)
#   pdns at http://localhost:8081/api/v1   (X-API-Key: demo-pdns-api-key)
```

For a real install (your own `.env` + compose, SQLite or Postgres) see
[`docs/02-INSTALLATION.md`](./docs/02-INSTALLATION.md).

### Local dev with HMR

```sh
nvm use                          # Node 24 from .nvmrc
npm ci                           # exact-pin install
cp .env.example .env.local       # set APP_SECRET_KEY + APP_ENCRYPTION_KEY; DATABASE_URL=file:./dev.db
docker compose up -d pdns        # a local PowerDNS to develop against (SQLite app runs on host)

npm run dev                      # http://localhost:3000
npm run validate                 # the CI gate - lint + typecheck + format + test
npm run test:integration         # integration suite (builds + boots the stack in Docker)
npm run db:generate              # after a schema change → new migration (also db:generate:sqlite)
npm run db:migrate               # apply pending migrations
```

Pre-push gate: `npm run ci:local` (= `act -j static-checks && act -j test` - [act](https://github.com/nektos/act)
runs the CI lint/typecheck/format + unit-test jobs locally, incl. `eslint .` without the local OOM;
the committed `.actrc` pins the runner image + workflow + host-native arch). Run
`npm run test:integration` natively (act can't nest docker-compose). CodeQL/Docker/Scorecard still need real CI.

## Project layout

```
app/                  Next.js App Router
  (auth)/login/       sign-in form
  (app)/              app shell, requires auth
    dashboard/        landing widgets (operator attention surfaces)
    zones/            amalgamated zone list + per-zone detail
    admin/            users, teams, roles, servers, clusters, oidc, tsig, autoprimaries,
                      zone-templates, settings, audit
    profile/          per-user account: password, sessions, MFA, API tokens
  api/                route handlers (REST + a couple of SSE streams)
  healthz, readyz     liveness + readiness probes

components/
  ui/                 generic primitives (data-table, dialog, toast, user-menu, …)
  domain/             feature-specific (record-table, admin-audit-panel, freshness chip, …)

lib/                  domain code, three-layer architecture enforced via ESLint
  auth/               sessions, providers (local, OIDC), MFA, CSRF, rate limit
  rbac/               CASL ability builder + scope matching
  pdns/               typed HTTP client, sync probes, cluster picker, zone operations
  db/                 Drizzle schemas (pg + sqlite-core), repositories
  audit/              append-only audit log, action vocabulary, secret redaction
  email/              SMTP transport + send API (env-driven, AUTH optional)
  crypto/             AES-256-GCM envelope encryption + HKDF subkeys
  validators/         Zod schemas at every boundary
  provisioning/       first-boot YAML applier (settings, roles, teams, templates, servers, oidc)
  realtime/           SSE event bus + zone-state poller
  client/             api-fetch (CSRF header injection)
  errors/             typed error hierarchy + secret redaction
  env.ts              boot-time env validation
  logger.ts           Pino structured logging
  client-ip.ts        proxy-aware client IP

proxy.ts              per-request CSP nonce + security headers (Next 16 proxy convention)
docker/               entrypoint that runs migrations then boots the server
drizzle/              generated PG migrations
drizzle-sqlite/       generated SQLite migrations
scripts/              migrate.ts, seed.ts, provision.ts, screenshots.mjs
tests/                vitest unit + integration (the latter wants a real Postgres on $TEST_DB_URL)
docs/                 ADRs, FEATURES, dev-setup
screenshots/          gallery of every page in 4 variants - desktop+light, desktop+dark,
                      mobile+light, mobile+dark; regen with `npm run screenshots`
                      (Playwright + iPhone-frame CSS, optional pngquant+oxipng post-pass)
```

## Working conventions

### Three-layer rule

Every request flows through **authentication → authorization → business logic** (ADR 0004).
Boundaries are enforced by `eslint.config.mjs`'s `import/no-restricted-paths`. If a violation
shows up in CI, fix the boundary; don't suppress the rule.

### Migrations

- Schema lives in `lib/db/schema/` (PG) and `lib/db/schema-sqlite/` (SQLite).
- After a change, run `npm run db:generate` (PG) and `npm run db:generate:sqlite` (SQLite) to
  produce the migration SQL.
- Migrations run inside the app container entrypoint at boot (ADR 0011). The Postgres path
  takes a `pg_advisory_lock` so multi-replica boots are serialized.

### Audit

Every write goes through `appendAudit({...})` from `lib/audit/log.ts`. Action names come from
the typed vocabulary in `lib/audit/actions.ts` - adding a new action means appending to that
file. `before`/`after` snapshots are auto-redacted for known secret field names (see
`lib/audit/redact.ts`); don't bypass.

### Auth on routes

Use `requireUser({ can: "..." })` on route handlers, `requireUserForPage({ can: "..." })` on
page components. CSRF on every mutating route via `requireCsrf(request)`. The client side
adds the `x-csrf-token` header automatically via `lib/client/api-fetch.ts`.

### Comments

Code comments explain **why** something is done a non-obvious way, not what it does. Names
should carry the what. Don't write comments that paraphrase the code; do write comments when
the code embodies a constraint a future reader would otherwise have to reverse-engineer.

### Tests

`npm run test` runs the vitest unit suite (no external deps). Integration tests under
`tests/integration/` need a Postgres instance - the runner skips them when `TEST_DATABASE_URL`
isn't set. CI runs both.

### Responsive UI (v1.1.4+)

Every page is **mobile-first responsive**. Lists use the shared `<DataTable>`
(`components/ui/data-table.tsx`) which reflows to labelled cards under `md`;
chrome (app-shell, header chip, theme toggle, capability badges) is built to
operate at 320 px. Sync state is communicated by `<SyncIndicator>` (animated
concentric rings, honours `prefers-reduced-motion`); fleet-wide verdict is
`globalAnyLagging()` from `lib/pdns/sync.ts`.

When adding a new list view, use `<DataTable>`. When showing replication
status, use `<SyncIndicator>` - don't roll a new dot/badge. See
[`docs/FEATURES.md` § 19](./docs/FEATURES.md#19-operator-ux--responsive-design)
for the full vocabulary.

### Screenshots

Every page lives in `screenshots/<light|dark>/<name>{-mobile}.png` and is
referenced from `screenshots/README.md` with `<picture>` for auto theme
switching. When you add a page or change a major surface, regen the relevant
shot:

```sh
node scripts/screenshots.mjs <page-name>          # one page, all 4 variants
SKIP_MOBILE=1 node scripts/screenshots.mjs <name> # desktop only
```

The runner expects the combined demo stack up + `must_change_password`
cleared on `admin@example.com` - full prereqs in
[`docs/dev-setup.md` → Regenerating screenshots](./docs/dev-setup.md#regenerating-screenshots).

## When working in this repo

- **Read the relevant ADR before touching a load-bearing area.** Auth, RBAC, sessions, CSP,
  PDNS client, migrations - each has an ADR that explains the why.
- **If a decision is wrong, change it.** Open an issue, write a new ADR that supersedes the
  old one (mark the old one `Superseded by NNNN`), update the index in `docs/adr/README.md`.
- **Standards live in `CONTRIBUTING.md`.** Read it before writing code - the rules are
  enforced and following them from the start saves review iterations.
- **No new top-level docs without consensus.** ADRs go in `docs/adr/`; runbooks in
  `docs/runbooks/`; everything else is a section in an existing doc.
