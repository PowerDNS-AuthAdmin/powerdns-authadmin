# Installation

Run PowerDNS-AuthAdmin in production with Docker Compose. The app is one image —
[`ghcr.io/powerdns-authadmin/powerdns-authadmin`](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin) —
and runs on **SQLite** or **Postgres**. Database migrations and the first-run
admin seed happen automatically on boot, so the container comes up ready to use.

Four steps: **pick a database → create `.env` → write `docker-compose.yml` → start.**

---

## Before you start

- **Docker** with the Compose plugin — `docker compose version` must be **v2+**.
- A directory to hold your two files (`.env` + `docker-compose.yml`). Everything
  below runs from inside it:

  ```sh
  mkdir powerdns-authadmin && cd powerdns-authadmin
  ```

### Which database?

|              | **SQLite**                                     | **Postgres**                                                                                    |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Use when     | one instance — homelab, evaluation, small team | multiple instances, or you want a managed DB                                                    |
| Storage      | one file in a Docker volume                    | a `postgres` service (or your own DB)                                                           |
| Replicas > 1 | ❌                                             | ✅ (also set `REDIS_URL` — see [High availability](../README.md#high-availability-replicas--1)) |

> The two database backends do **not** share a migration history — switching
> later is a fresh install. Pick one now.

---

## 1. Create `.env` (secrets)

Two secrets are **required** and must be unique to your deployment. This command
generates them, picks a bootstrap admin password, and writes `.env`. **Run it
once.**

```sh
{
  echo "APP_SECRET_KEY=$(openssl rand -base64 32)"
  echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  echo "APP_URL=https://dns.example.com"
  echo "BOOTSTRAP_ADMIN_EMAIL=admin@example.com"
  echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)"
  # Postgres only — delete this line if you chose SQLite:
  echo "POSTGRES_PASSWORD=$(openssl rand -base64 18)"
} > .env
chmod 600 .env
```

Then edit `.env`: set **`APP_URL`** to your real public URL and
**`BOOTSTRAP_ADMIN_EMAIL`** to your address. Note the generated
`BOOTSTRAP_ADMIN_PASSWORD` — you'll use it for the first login (and change it
immediately).

| Variable                              | Purpose                                                      | Constraint                     |
| ------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| `APP_SECRET_KEY`                      | Signs sessions, CSRF tokens, API-token HMACs                 | ≥ 32 characters                |
| `APP_ENCRYPTION_KEY`                  | Encrypts stored PowerDNS API keys, OIDC secrets, MFA secrets | base64 decoding to ≥ 32 bytes  |
| `APP_URL`                             | Public, browser-visible URL (no trailing slash)              | e.g. `https://dns.example.com` |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | The first admin account (set together)                       | password ≥ 12 chars            |

> ⚠️ **Generate the two keys once and never change them.** Rotating
> `APP_ENCRYPTION_KEY` makes every stored PowerDNS API key, OIDC secret, and MFA
> secret undecryptable; changing `APP_SECRET_KEY` logs everyone out. Back up
> `.env` — don't regenerate it. (The app refuses to start if either key is
> missing, too short, or a placeholder like `changeme`.)

Compose loads `.env` automatically, so the same values are reused on every `up`,
`down`, and restart — there are no shell `export`s to remember.

---

## 2. Write `docker-compose.yml`

Pick the block matching your database choice.

### Option A — SQLite

```yaml
# docker-compose.yml
services:
  app:
    image: ghcr.io/powerdns-authadmin/powerdns-authadmin:latest
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      APP_URL: ${APP_URL}
      DATABASE_URL: file:/data/powerdns_authadmin.db
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      BOOTSTRAP_ADMIN_EMAIL: ${BOOTSTRAP_ADMIN_EMAIL}
      BOOTSTRAP_ADMIN_PASSWORD: ${BOOTSTRAP_ADMIN_PASSWORD}
    volumes:
      - app-data:/data
volumes:
  app-data:
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
      APP_URL: ${APP_URL}
      DATABASE_URL: postgres://pdns:${POSTGRES_PASSWORD}@postgres:5432/powerdns_authadmin
      APP_SECRET_KEY: ${APP_SECRET_KEY}
      APP_ENCRYPTION_KEY: ${APP_ENCRYPTION_KEY}
      BOOTSTRAP_ADMIN_EMAIL: ${BOOTSTRAP_ADMIN_EMAIL}
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

> **Production tip:** pin a version (`:1.1.2`) instead of `:latest` so deploys
> are deterministic. See [Upgrading](./09-UPGRADING.md).

---

## 3. Start

```sh
docker compose up -d
docker compose logs -f app   # watch migrations + seed run, then "Ready"
```

Later, `docker compose down` then `up -d` reuses the same `.env` and data.
`docker compose down -v` **deletes the data volume** — only use it to start over.

---

## 4. First login

Open `APP_URL`, sign in as `BOOTSTRAP_ADMIN_EMAIL` with the bootstrap password,
and set a new password when prompted (the bootstrap admin is flagged
"must change password"). Then add your PowerDNS backend(s) under **Admin →
PowerDNS servers** ([Connecting backends](./04-BACKENDS.md)) — or define them in
a [provisioning file](./06-PROVISIONING.md).

The bootstrap admin seeds only when **both** `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` are set. It's idempotent — keyed on the email, it
ensures that account exists and never clobbers an existing one.

---

## Reference

### Behind a reverse proxy

Terminate TLS at your proxy (nginx, Caddy, Traefik, a cloud LB) and forward to
the app's port 3000. Two things matter:

1. **`APP_URL` is the public URL** — it builds OIDC redirect URIs, email links,
   and cookie/CSP origins. A wrong value breaks SSO and cookies.
2. **The proxy must set `X-Forwarded-For` / `X-Real-IP`** to the real client IP
   (and _overwrite_ any client-supplied value, never append). The app always
   trusts these for audit + rate limiting — there is no `TRUST_PROXY` toggle.

Minimal Caddy example:

```caddy
dns.example.com {
    reverse_proxy app:3000
}
```

### Secrets from files (Docker / Kubernetes secrets)

Every variable also accepts a `_FILE` suffix pointing at a file whose contents
are the value:

```yaml
environment:
  APP_SECRET_KEY_FILE: /run/secrets/app_secret_key
  APP_ENCRYPTION_KEY_FILE: /run/secrets/app_encryption_key
secrets:
  - app_secret_key
  - app_encryption_key
```

If both `FOO` and `FOO_FILE` are set, the inline value wins and a warning is logged.

### What happens on boot

The entrypoint runs four stages; **any failure aborts the boot** (a broken
migration or bad provisioning file gives a refused start, not a degraded run):

1. **Migrate** — apply pending schema changes. Opt out: `MIGRATE_ON_BOOT=false`.
2. **Seed** — create the five system roles and (if configured) the bootstrap admin. Opt out: `SEED_ON_BOOT=false`.
3. **Provision** — apply `PROVISIONING_FILE` once, if set. Opt out: `PROVISION_ON_BOOT=false`. See [Provisioning](./06-PROVISIONING.md).
4. **Start** the server.

To run migrations as a separate CI/CD step, set `MIGRATE_ON_BOOT=false` and run
`npm run db:migrate` (with `DATABASE_URL` set) before starting the app.

### Health checks

| Endpoint       | Meaning                                                 | Use for                     |
| -------------- | ------------------------------------------------------- | --------------------------- |
| `GET /healthz` | Process is alive                                        | Liveness probe              |
| `GET /readyz`  | DB reachable **and** migrations at the expected version | Readiness probe / LB gating |

`/readyz` fails while migrations are mid-flight, so a rolling deploy won't send
traffic to a replica that isn't ready.

### Backups

- **SQLite** — back up the `app-data` volume (the DB is a single file at the
  `DATABASE_URL` path). Back up `APP_ENCRYPTION_KEY` alongside it, or the stored
  secrets are unreadable.
- **Postgres** — `pg_dump` / `pg_restore` or volume snapshots:

  ```sh
  docker compose exec postgres pg_dump -U pdns powerdns_authadmin > backup.sql
  ```

---

## Next steps

- [Configuration](./03-CONFIGURATION.md) — every environment variable.
- [Connecting PowerDNS backends](./04-BACKENDS.md).
- [Hardening](./08-HARDENING.md) and [Upgrading](./09-UPGRADING.md).

---

[← Docs index](./README.md)
