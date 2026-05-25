<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./public/brand/logo-wordmark-dark.png" />
    <img src="./public/brand/logo-wordmark-light.png" alt="PowerDNS-AuthAdmin" width="440" />
  </picture>
</p>

# PowerDNS-AuthAdmin

> A modern, self-hosted DNS administration UI for PowerDNS Authoritative — first-class RBAC,
> audit log with diffs, SSO with group-driven role mapping, optimistic concurrency in the editor,
> and a UI built for teams that actually run multi-backend infrastructure.

[![CI](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/ci.yml?query=branch%3Amain)
[![Release](https://img.shields.io/github/v/release/PowerDNS-AuthAdmin/powerdns-authadmin)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/releases/latest)
[![Container: GHCR](https://img.shields.io/badge/ghcr.io-powerdns--authadmin-2496ED?logo=docker&logoColor=white)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin)
[![GHCR version](https://ghcr-badge.egpl.dev/powerdns-authadmin/powerdns-authadmin/latest_tag?ignore=latest,edge&label=ghcr.io&color=%232ea44f)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin)
[![GHCR image size](https://ghcr-badge.egpl.dev/powerdns-authadmin/powerdns-authadmin/size?tag=latest&label=image%20size&color=%232ea44f)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin)
[![GHCR pulls](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fghcr-badge.elias.eu.org%2Fapi%2Fpowerdns-authadmin%2Fpowerdns-authadmin&query=%24.downloadCount&label=ghcr%20pulls&logo=docker&logoColor=white&color=2496ED)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin)
[![License: MIT](https://img.shields.io/github/license/PowerDNS-AuthAdmin/powerdns-authadmin)](./LICENSE)

[![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=next.js)](https://nextjs.org)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)

PowerDNS-AuthAdmin manages one or many PowerDNS Authoritative backends from a single web app. It
ships with a permissive RBAC engine, OIDC single sign-on with group→role mapping, transactional
zone editing, NOTIFY-aware sync probes for cluster + primary/secondary topologies, an append-only
audit log, scoped API tokens, and a YAML-driven first-boot provisioning system that brings up a
ready-to-use install without a single click.

**PowerDNS Auth version compatibility tests:**

[![PowerDNS 4.6](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-46.yml/badge.svg)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-46.yml)
[![PowerDNS 4.7](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-47.yml/badge.svg)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-47.yml)
[![PowerDNS 4.8](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-48.yml/badge.svg)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-48.yml)
[![PowerDNS 4.9](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-49.yml/badge.svg)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-49.yml)
[![PowerDNS 5.0](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-50.yml/badge.svg)](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/actions/workflows/pdns-compat-50.yml)

## At a glance

- **Multi-backend.** One install fronts standalone primaries, primary + secondaries groups, and
  multi-primary clusters. Backends are visible side-by-side; zones merge into one amalgamated
  list. Per-cluster peer-selection strategies (round-robin / random / lowest-latency / least-load)
  route reads and writes to a member of the cluster.
- **Real RBAC.** Five system roles plus org-defined custom roles. Permissions span ~60 actions
  across zones, records, DNSSEC, TSIG, metadata, autoprimaries, templates, users, teams, servers,
  API tokens, audit, and OIDC providers. Assignments scope to global / team / zone / server.
- **Auth.** Local accounts (Argon2id), generic OIDC with PKCE + per-provider group→role mapping,
  TOTP MFA (greyed out for SSO-only users — the IdP is the trust root), `pda_pat_` API tokens
  with per-token permission scopes.
- **RP-initiated logout.** OIDC sessions sign you out at the IdP, not just locally; the
  `end_session_endpoint` + `id_token_hint` flow lands you on the IdP's signed-out screen.
- **Zones + records.** Per-RRset editor with diff-before-apply, zone cloning, zone templates
  (NS + SOA timers + prelude records + zone-object settings + per-kind metadata), per-type
  record validators, optimistic concurrency at the RRset level.
- **DNSSEC.** Cryptokey create / update / delete with per-key activity surfaced from the audit
  log. Zone metadata management with diff history.
- **TSIG + autoprimaries.** Manage TSIG keys (read vs reveal split into separate permissions),
  configure autoprimary registrations.
- **Cluster + sync.** A "cluster" is N writable PDNS peers behind a replicated store. Sync probe
  for primary+secondaries: compare every secondary's serial against the primary, record-for-record
  diff on demand. Sync probe for clusters: same UI shape, all peers compared against the
  highest-serial peer as anchor.
- **Audit.** Append-only log of every write. Before/after JSONB snapshots redacted for known
  secret fields. Per-zone history feed with chip-coloured action types. Operator-driven export.
- **Provisioning.** `provisioning.yaml` applied on first boot: settings, custom roles, teams,
  zone templates, PDNS clusters + servers, demo zones, OIDC providers (with group mappings).
  See [`provisioning.example.yaml`](./provisioning.example.yaml) for an exhaustive reference.
- **Observability.** Pino structured logs (secret-redacted), Prometheus `/metrics`, `/healthz`
  liveness, `/readyz` readiness (gated on DB + migration version).
- **Self-contained.** One Docker image, no CDN, no telemetry phone-home. Migrations run inside
  the app entrypoint; on Postgres they're serialized by an advisory lock so multi-replica boots
  are safe.

The full feature catalog with module-level docs is in [`docs/FEATURES.md`](./docs/FEATURES.md).

## Screenshots

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/dashboard.png" />
    <img src="screenshots/light/dashboard.png" alt="Dashboard — live PowerDNS stats and operator attention surfaces" width="900" />
  </picture>
</p>

<table>
  <tr>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/powerdns-servers.png" />
        <img src="screenshots/light/powerdns-servers.png" alt="PowerDNS servers" />
      </picture>
      <br /><sub><b>Multi-backend</b> — clusters, primary + secondaries, and standalone primaries side by side with live sync status.</sub>
    </td>
    <td width="50%">
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/zones-list.png" />
        <img src="screenshots/light/zones-list.png" alt="Zones" />
      </picture>
      <br /><sub><b>Amalgamated zones</b> — every backend's zones in one searchable list with serial + sync state.</sub>
    </td>
  </tr>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/record-editor.png" />
        <img src="screenshots/light/record-editor.png" alt="Record editor" />
      </picture>
      <br /><sub><b>Per-RRset editor</b> with per-type validation.</sub>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/record-diff.png" />
        <img src="screenshots/light/record-diff.png" alt="Diff before apply" />
      </picture>
      <br /><sub><b>Diff-before-apply</b> — a before/after diff on every save.</sub>
    </td>
  </tr>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/roles.png" />
        <img src="screenshots/light/roles.png" alt="Roles" />
      </picture>
      <br /><sub><b>RBAC</b> — system + custom roles, scoped global / team / zone / server.</sub>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="screenshots/dark/audit-log.png" />
        <img src="screenshots/light/audit-log.png" alt="Audit log" />
      </picture>
      <br /><sub><b>Append-only audit log</b> with redacted before/after snapshots.</sub>
    </td>
  </tr>
</table>

## Run it

The app ships as a single image — **[`ghcr.io/powerdns-authadmin/powerdns-authadmin`](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin)**.
It runs on **SQLite** (single instance: homelab, eval, small teams) or **Postgres** (multi-instance,
write-concurrent). Migrations and the system-role seed run automatically on boot.

> New here? The [Quickstart](./docs/01-QUICKSTART.md) gets you clicking around in ~2 minutes; the
> [Installation guide](./docs/02-INSTALLATION.md) covers a real production deploy.

### Try it instantly — the minimal-demo stack

A throwaway SQLite stack with a bundled PowerDNS and 10 pre-seeded demo zones:

```sh
git clone https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin.git
cd powerdns-authadmin
docker compose up -d
#   → http://localhost:3000   (login: admin@example.com / change-me-now)
```

> ⚠️ Demo only: it reads `.env.example` directly, which ships public throwaway secrets. Don't expose it.

### Production — SQLite

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/powerdns-authadmin/powerdns-authadmin:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      APP_URL: https://dns.example.com
      DATABASE_URL: file:/data/powerdns_authadmin.db
      APP_SECRET_KEY: ${APP_SECRET_KEY} # openssl rand -base64 32
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY} # openssl rand -base64 32
      BOOTSTRAP_ADMIN_EMAIL: admin@example.com
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD} # ≥12 chars
    volumes:
      - app-data:/data
volumes:
  app-data:
```

```sh
export APP_SECRET_KEY=$(openssl rand -base64 32)
export APP_ENCRYPTION_KEY=$(openssl rand -base64 32)
export BOOTSTRAP_ADMIN_PASSWORD='a-strong-password'
docker compose up -d
```

Then add your PowerDNS backend(s) under **Admin → PowerDNS servers** (or via a provisioning file).

### Production — Postgres

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/powerdns-authadmin/powerdns-authadmin:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      APP_URL: https://dns.example.com
      DATABASE_URL: postgres://pdns:${POSTGRES_PASSWORD}@postgres:5432/powerdns_authadmin
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      BOOTSTRAP_ADMIN_EMAIL: admin@example.com
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD}
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: pdns
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: powerdns_authadmin
    volumes: ["pg-data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pdns -d powerdns_authadmin"]
      interval: 5s
      timeout: 5s
      retries: 10
volumes:
  pg-data:
```

### High availability (replicas > 1)

To run more than one app replica, use **Postgres + Redis** and put a load balancer
in front. Sessions are already shared (they live in Postgres); setting `REDIS_URL`
makes the three remaining per-process pieces — auth rate limiting, one-time reveal
tokens, and the realtime SSE event bus — coordinate across replicas. Without Redis
those degrade to per-replica behaviour (looser rate limits, reveal tokens that only
work on their origin replica, live updates that don't cross replicas), so Redis is
**required** past one replica. See [ADR-0016](./docs/adr/0016-redis-horizontal-scale.md).

> SQLite is single-instance only — a file-backed DB isn't shared storage. HA means
> Postgres. The boot log says so if it detects the combination.

```yaml
# docker-compose.ha.yml — Postgres + Redis, app fronted by your load balancer.
services:
  app:
    image: ghcr.io/powerdns-authadmin/powerdns-authadmin:latest
    restart: unless-stopped
    # No host port — your load balancer (nginx/Traefik/cloud LB) fronts the replicas.
    expose: ["3000"]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    environment:
      APP_URL: https://dns.example.com
      DATABASE_URL: postgres://pdns:${POSTGRES_PASSWORD}@postgres:5432/powerdns_authadmin
      REDIS_URL: redis://redis:6379 # ← enables cross-replica coordination
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      BOOTSTRAP_ADMIN_EMAIL: admin@example.com
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD}
    # Plain compose: `docker compose -f docker-compose.ha.yml up -d --scale app=3`.
    # Swarm / k8s: set replicas in your orchestrator instead.
    deploy:
      replicas: 3
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: pdns
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: powerdns_authadmin
    volumes: ["pg-data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pdns -d powerdns_authadmin"]
      interval: 5s
      timeout: 5s
      retries: 10
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--save", "", "--appendonly", "no"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  pg-data:
```

> Migrations are serialized across replica boots by a Postgres advisory lock
> (ADR-0011), so starting N replicas at once is safe — only one applies migrations.
> Redis here is a coordination cache, not a datastore: persistence is off
> (`--save "" --appendonly no`) because nothing it holds needs to survive a restart.

### Configuration

Every variable is documented in [`.env.example`](./.env.example). The essentials:

| Variable                                             | Required    | What                                                                   |
| ---------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| `APP_URL`                                            | ✅          | Public URL the app is served from, no trailing slash.                  |
| `APP_SECRET_KEY`                                     | ✅          | Session / CSRF / token HMAC secret. `openssl rand -base64 32`.         |
| `APP_ENCRYPTION_KEY`                                 | ✅          | AES-256 key (base64, decodes to ≥32 bytes). `openssl rand -base64 32`. |
| `DATABASE_URL`                                       | ✅          | `file:/data/powerdns_authadmin.db` (SQLite) or `postgres://…`.         |
| `REDIS_URL`                                          | optional    | Enables cross-replica coordination — **required** for replicas > 1.    |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD`                | ⭐          | First SuperAdmin (password ≥12 chars).                                 |
| `OIDC_*`                                             | optional    | SSO — or add providers in the UI instead.                              |
| `SMTP_*`                                             | optional    | Transactional email (verify-email, password reset).                    |
| `APP_PDNS_ALLOW_PRIVATE_NETWORKS` / `_INSECURE_HTTP` | situational | Allow internal-network / `http://` PDNS backends.                      |
| `APP_OIDC_ALLOW_PRIVATE_NETWORKS` / `_INSECURE_HTTP` | situational | Allow internal-network / `http://` OIDC issuers (SSRF guard).          |

Full reference with every variable: **[Configuration](./docs/03-CONFIGURATION.md)**. For SSO setup
(env vs provisioning vs UI), see **[OIDC single sign-on](./docs/05-OIDC.md)**.

### Advanced topologies

To see a primary + secondaries group or a multi-primary cluster wired up end-to-end (Postgres-backed,
all official PowerDNS images), use the topology compose files:
[`docker-compose-combined.yml`](./docker-compose-combined.yml),
[`docker-compose-primary-secondaries.yml`](./docker-compose-primary-secondaries.yml),
[`docker-compose-multi-primary.yml`](./docker-compose-multi-primary.yml).

### Local development

```sh
nvm use && npm ci                  # Node 24 from .nvmrc
cp .env.example .env.local         # set APP_SECRET_KEY + APP_ENCRYPTION_KEY
docker compose up pdns -d          # a local PowerDNS to talk to
npm run dev                        # http://localhost:3000
npm run validate                   # lint + typecheck + format + test
```

Full workflow + troubleshooting in [`docs/dev-setup.md`](./docs/dev-setup.md).

## Documentation

Full guides live in **[`docs/`](./docs/)** — start at the
[documentation index](./docs/README.md).

| Guide                                                 | Purpose                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| [Quickstart](./docs/01-QUICKSTART.md)                 | Run the demo stack end-to-end in ~2 minutes.                     |
| [Installation](./docs/02-INSTALLATION.md)             | Production install — SQLite or Postgres, TLS, backups, upgrades. |
| [Configuration](./docs/03-CONFIGURATION.md)           | Every environment variable, grouped and explained.               |
| [Connecting PowerDNS backends](./docs/04-BACKENDS.md) | Primaries, secondaries, and multi-primary clusters.              |
| [OIDC single sign-on](./docs/05-OIDC.md)              | SSO with group → role mapping (env vs provisioning vs UI).       |
| [First-boot provisioning](./docs/06-PROVISIONING.md)  | Bring up a configured install from one YAML file.                |
| [Roles & permissions (RBAC)](./docs/07-RBAC.md)       | Roles, the permission vocabulary, and scopes.                    |
| [Hardening & best practices](./docs/08-HARDENING.md)  | Lock down a production deployment.                               |
| [Upgrading](./docs/09-UPGRADING.md)                   | Move to a new version safely.                                    |
| [Troubleshooting](./docs/10-TROUBLESHOOTING.md)       | Fix startup errors and backend connectivity.                     |

### Reference

| Doc                                                        | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [`docs/FEATURES.md`](./docs/FEATURES.md)                   | The full feature catalog with module pointers.                       |
| [`docs/dev-setup.md`](./docs/dev-setup.md)                 | Local development workflow.                                          |
| [`docs/adr/`](./docs/adr/)                                 | Architecture Decision Records — why the codebase is shaped this way. |
| [`provisioning.example.yaml`](./provisioning.example.yaml) | Exhaustive provisioning reference.                                   |
| [`.env.example`](./.env.example)                           | Documented environment variables.                                    |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md)                     | Code standards, testing, security, perf budgets.                     |
| [`SECURITY.md`](./SECURITY.md)                             | Vulnerability reporting policy.                                      |
| [`CLAUDE.md`](./CLAUDE.md)                                 | Guidance for AI coding agents working on this repo.                  |

## Status

**Production-ready.** Deploy on SQLite or Postgres with the published image; see
[Run it](#run-it). Released versions and changes are in
[`CHANGELOG.md`](./CHANGELOG.md); the roadmap is tracked in GitHub issues —
contributions welcome, read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first.

## License

[MIT](./LICENSE) — copy, modify, distribute, or sell with attribution.
