# Dev setup

The path from "fresh `git clone`" to "I broke a test, what now?" — every command is meant to
be safe to copy-paste.

## Prerequisites

- **Node.js 24 LTS.** The `.nvmrc` pins the major version; `nvm use` picks it up.
- **npm 10+.** Ships with Node 24.
- **Docker** with Compose v2. Needed for Postgres + Redis + the sandbox PowerDNS stack.

## One-time setup

```sh
git clone https://github.com/jseifeddine/powerdns-authadmin
cd PowerDNS-AuthAdmin

nvm use            # reads .nvmrc
npm ci             # exact-pin install

cp .env.example .env.local
# Generate the two required secrets — paste them into .env.local under
# APP_SECRET_KEY and APP_ENCRYPTION_KEY:
openssl rand -base64 32
openssl rand -base64 32
```

## Daily loop

```sh
# Start dependencies (Postgres + Redis + sandbox PDNS)
docker compose up -d

# Dev server with hot reload — migrations run on app boot (ADR 0011)
npm run dev        # → http://localhost:3000
```

Health endpoints to confirm everything's wired:

- `GET /healthz` — `{"status":"ok",...}` 200.
- `GET /readyz` — `{"status":"ok","checks":{"database":"ok"}}` 200 when Postgres is reachable,
  503 otherwise.

## Before opening a PR

```sh
# One command runs lint, typecheck, format check, and unit tests.
npm run validate
```

If any of those fail locally, CI will too. Fix before pushing.

## Commonly-needed commands

| Command                           | Purpose                                                                |
| --------------------------------- | ---------------------------------------------------------------------- |
| `npm run dev`                     | Next.js dev server with HMR.                                           |
| `npm run build`                   | Production build (used by Docker too).                                 |
| `npm run start`                   | Run the production build.                                              |
| `npm run lint` / `lint:fix`       | ESLint with our flat config + import-boundary rules.                   |
| `npm run format` / `format:check` | Prettier.                                                              |
| `npm run typecheck`               | `tsc --noEmit` against the whole tree.                                 |
| `npm run test` / `test:watch`     | Vitest unit tests.                                                     |
| `npm run test:integration`        | HTTP integration tests — builds + boots the test stack via Docker.     |
| `npm run test:integration:bare`   | Same vitest pass, but assumes the test stack is already up.            |
| `npm run db:generate`             | Generate a new Drizzle migration from PG schema changes.               |
| `npm run db:generate:sqlite`      | Generate a new Drizzle migration from SQLite schema changes.           |
| `npm run db:migrate`              | Apply pending migrations.                                              |
| `npm run db:studio`               | Drizzle Studio (browser UI for the DB).                                |
| `npm run audit:strict`            | `npm audit` gating on high/critical CVEs in prod deps.                 |
| `npm run validate`                | Lint + typecheck + format check + unit tests — the CI-equivalent gate. |

## Troubleshooting

### `[env] Environment validation failed`

You're missing a required environment variable. The error message lists exactly which ones.
Check `.env.local` against `.env.example`.

### Database connection refused

```sh
docker compose ps
docker compose logs postgres
```

Confirm `postgres` shows `(healthy)`. If not, `docker compose up -d --force-recreate postgres`.

### "Cannot find module 'server-only'"

Add `import "server-only"` to the top of any module that uses environment secrets, the DB, or
the PDNS client. The directive is enforced at build time — see Next.js docs.

### `invalid_client` from an OIDC provider

The two log lines `oidc.discovery.loaded` and `oidc.callback.failure` carry the diagnostic
fields (`secret_fp`, `auth_method_used`, `auth_methods_supported`). The most common cause is a
clipboard whitespace mismatch in the client secret — re-save the secret on the provider edit
page and the validator's trim will normalize it.

## Demo stacks

For exercising multi-backend topologies side-by-side:

- `docker-compose-primary-secondaries.yml` — one primary + three secondaries with auto-secondary
  registration via supermaster.
- `docker-compose-multi-primary.yml` — three writable peers sharing a MariaDB backend (cluster
  shape).
- `docker-compose-combined.yml` — all three topologies in one stack, plus generated demo zones
  via the provisioning file.

## What's where

- `app/` — Next.js routes.
- `lib/` — domain logic. Read `CLAUDE.md` or `docs/FEATURES.md` for the layout.
- `components/` — React components.
- `docs/adr/` — architecture decisions. Read these before changing the parts of the codebase
  they describe.

## Where to ask

- Issues for bugs / proposals.
- Discussions for questions.
- Security findings: GitHub Security Advisories (private). See `SECURITY.md`.
