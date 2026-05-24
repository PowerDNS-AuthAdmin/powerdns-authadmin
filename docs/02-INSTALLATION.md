# Installation

Run PowerDNS-AuthAdmin in production. The app ships as a single image —
[`ghcr.io/powerdns-authadmin/powerdns-authadmin`](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin) —
that runs on **SQLite** or **Postgres**. Migrations and the system-role seed run
automatically on boot, so a fresh container comes up ready to use.

- **SQLite** — single instance: homelab, evaluation, small teams. One file, no
  separate database service.
- **Postgres** — multi-instance, write-concurrent, the production default for
  teams. Boots are serialised by an advisory lock so multiple replicas are safe.
  For replicas > 1 also set `REDIS_URL` (cross-replica rate limiting, reveal
  tokens, and live updates) — see [High availability](../README.md#high-availability-replicas--1).

Switching dialects later is a fresh install — the two schema histories don't
share migrations. Pick one up front.

## 1. Generate secrets

Two secrets are **required** and must be unique per deployment. Generate them
once and keep them safe — rotating `APP_ENCRYPTION_KEY` later makes every stored
PowerDNS API key and OIDC client secret undecryptable.

```sh
openssl rand -base64 32   # → APP_SECRET_KEY      (session / CSRF / token HMAC)
openssl rand -base64 32   # → APP_ENCRYPTION_KEY  (AES-256 envelope for secrets at rest)
```

| Secret               | Used for                                            | Constraint                    |
| -------------------- | --------------------------------------------------- | ----------------------------- |
| `APP_SECRET_KEY`     | Signing sessions, CSRF tokens, API-token HMACs      | ≥ 32 chars                    |
| `APP_ENCRYPTION_KEY` | Encrypting PowerDNS API keys + OIDC secrets at rest | base64 decoding to ≥ 32 bytes |

The app refuses to start if either is missing, too short, or an obvious
placeholder (`changeme`, `secret`, …).

## 2. Deploy

### Option A — SQLite

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
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
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

### Option B — Postgres

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

## 3. First login

Open `APP_URL`, sign in as `BOOTSTRAP_ADMIN_EMAIL` with the bootstrap password,
and set a new password when prompted (the bootstrap admin is created with
"must change password on next login"). Then add your PowerDNS backend(s) under
**Admin → PowerDNS servers** — see [Connecting PowerDNS backends](./04-BACKENDS.md) —
or define them in a [provisioning file](./06-PROVISIONING.md).

> The bootstrap admin only seeds when both `BOOTSTRAP_ADMIN_EMAIL` and
> `BOOTSTRAP_ADMIN_PASSWORD` are set (together — setting one without the other is
> a startup error). It's idempotent: it ensures the account exists but won't
> clobber an existing one.

## Running behind a reverse proxy

Terminate TLS at your proxy (nginx, Caddy, Traefik, a cloud LB) and forward to
the app's port 3000. Two things matter:

1. **`APP_URL` must be the public, browser-visible URL** (`https://dns.example.com`,
   no trailing slash). It's used to build OIDC redirect URIs, email links, and
   CSP origin checks — a wrong value breaks SSO and cookies.
2. **The proxy must set `X-Forwarded-For` / `X-Real-IP`** to the real client IP.
   The app always trusts these headers for IP attribution (audit log, rate
   limiting) — there is no `TRUST_PROXY` toggle — so your proxy must _overwrite_
   any client-supplied value, never append to it.

Minimal Caddy example:

```caddy
dns.example.com {
    reverse_proxy app:3000
}
```

## Secrets from files (Docker / Kubernetes)

Every variable also accepts a `_FILE` suffix: point it at a file whose contents
are the value. Ideal for Docker secrets and Kubernetes `Secret` volumes.

```yaml
environment:
  APP_SECRET_KEY_FILE: /run/secrets/app_secret_key
  APP_ENCRYPTION_KEY_FILE: /run/secrets/app_encryption_key
secrets:
  - app_secret_key
  - app_encryption_key
```

If both `FOO` and `FOO_FILE` are set, the inline value wins and a warning is logged.

## What happens on boot

The container entrypoint runs four stages, and **any failure aborts the boot** —
a broken migration or malformed provisioning file produces a refused start, not a
silently degraded run:

1. **Migrations** — apply pending schema changes. Opt out: `MIGRATE_ON_BOOT=false`.
2. **Seed** — create the five system roles and (if configured) the bootstrap
   admin. Opt out: `SEED_ON_BOOT=false`.
3. **Provisioning** — apply `PROVISIONING_FILE` once. Opt out: `PROVISION_ON_BOOT=false`
   or leave `PROVISIONING_FILE` unset. See [Provisioning](./06-PROVISIONING.md).
4. **Start** the Next.js server.

To run migrations as a separate CI/CD step instead of on boot, set
`MIGRATE_ON_BOOT=false` and run `npm run db:migrate` (with `DATABASE_URL` set)
before starting the app.

## Health checks

Wire these into your orchestrator:

| Endpoint       | Meaning                                                 | Use for                     |
| -------------- | ------------------------------------------------------- | --------------------------- |
| `GET /healthz` | Process is alive                                        | Liveness probe              |
| `GET /readyz`  | DB reachable **and** migrations at the expected version | Readiness probe / LB gating |

`/readyz` deliberately fails while migrations are mid-flight, so a rolling deploy
won't send traffic to a replica that isn't ready.

## Backups

- **SQLite:** the database is a single file at the path in `DATABASE_URL`
  (e.g. `/data/powerdns_authadmin.db` inside the `app-data` volume). Back up the
  volume, or copy the file while the app is stopped (or use `sqlite3 … ".backup"`
  for a hot copy). Losing `APP_ENCRYPTION_KEY` makes the backup's stored API keys
  unreadable — back up the key alongside the data.
- **Postgres:** standard `pg_dump` / `pg_restore` or volume snapshots.

```sh
# Postgres logical backup
docker compose exec postgres pg_dump -U pdns powerdns_authadmin > backup.sql
```

## Upgrading

Pull a newer image tag and recreate the container — migrations run automatically.
**Back up first**, and read [Upgrading](./09-UPGRADING.md) for version pinning and
rollback caveats.

## Next steps

- [Configuration reference](./03-CONFIGURATION.md) — every environment variable.
- [Connecting PowerDNS backends](./04-BACKENDS.md).
- [Hardening & best practices](./08-HARDENING.md).

---

[← Docs index](./README.md)
