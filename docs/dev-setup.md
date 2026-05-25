# Dev setup

The path from "fresh `git clone`" to "I broke a test, what now?" — every command is meant to
be safe to copy-paste.

## Prerequisites

- **Node.js 24 LTS.** The `.nvmrc` pins the major version; `nvm use` picks it up.
- **npm 10+.** Ships with Node 24.
- **Docker** with Compose v2 — runs a local PowerDNS backend to develop against.

## One-time setup

```sh
git clone https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin
cd powerdns-authadmin

nvm use            # reads .nvmrc
npm ci             # exact-pin install

cp .env.example .env.local
```

Then edit `.env.local`:

- Set `APP_SECRET_KEY` and `APP_ENCRYPTION_KEY` (generate each with `openssl rand -base64 32`).
- Point `DATABASE_URL` at a local SQLite file the dev server can write — e.g.
  `DATABASE_URL=file:./dev.db` (the shipped default `file:/data/...` is the in-container path).

Redis is optional in dev — everything falls back to an in-process path when `REDIS_URL` is unset.

## Daily loop

```sh
# A local PowerDNS to talk to (just the pdns service from the demo stack)
docker compose up -d pdns

# Dev server with hot reload — migrations run on app boot (ADR 0011)
npm run dev        # → http://localhost:3000
```

Health endpoints to confirm everything's wired:

- `GET /healthz` — `{"status":"ok",...}` 200.
- `GET /readyz` — `{"status":"ok","checks":{"database":"ok"}}` 200 when the database is reachable,
  503 otherwise.

## Before opening a PR

```sh
# One command runs lint, typecheck, format check, and unit tests.
npm run validate
```

Run the integration suite too if you touched routes, repositories, or auth — it
builds + boots the stack in Docker:

```sh
npm run test:integration
```

**Run the CI workflow locally with [`act`](https://github.com/nektos/act)** to
catch failures before they hit GitHub. It runs the GitHub Actions jobs in Docker:

```sh
act -j static-checks -W .github/workflows/ci.yml --container-architecture linux/amd64
act -j test          -W .github/workflows/ci.yml --container-architecture linux/amd64
```

`act` reliably runs the **JS-action jobs** (`static-checks`, `test`, `audit`) —
and runs `eslint .` without the host-memory limits you can hit locally. It does
**not** stand in for GitHub-hosted CodeQL, the Docker build/publish, Scorecard,
or dependency-review (those need GitHub runners / tokens), so those remain the
authority on the PR. First run pulls the runner image (~1 GB).

If any of these fail locally, CI will too. Fix before pushing.

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

### PowerDNS backend unreachable

```sh
docker compose ps
docker compose logs pdns
```

Confirm `pdns` shows `(healthy)`. If not, `docker compose up -d --force-recreate pdns`.

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
