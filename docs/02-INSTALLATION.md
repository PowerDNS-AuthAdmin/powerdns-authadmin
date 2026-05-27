# Installation

Two supported install paths:

| Path                                       | Use when                                                                                | Skip to                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **A — Docker** (recommended for prod)      | You want a single image, scheduler-friendly health checks, auto-migrate on boot.        | [§ Docker install](#a--docker-install)           |
| **B — From source** (build & run natively) | You can't (or won't) run Docker, you're packaging for systemd/PM2, or doing first dive. | [§ From-source install](#b--from-source-install) |

Either path runs on **SQLite** (one file, single instance) or **Postgres**
(any number of replicas + Redis). Database migrations + the first-run admin
seed happen automatically — the install comes up ready to use.

> The two database backends do **not** share a migration history — switching
> later is a fresh install. Pick one now.

|              | **SQLite**                                     | **Postgres**                                                                                    |
| ------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Use when     | one instance — homelab, evaluation, small team | multiple instances, or you want a managed DB                                                    |
| Storage      | one file in a Docker volume / on the host      | a `postgres` service (or your own DB)                                                           |
| Replicas > 1 | ❌                                             | ✅ (also set `REDIS_URL` — see [High availability](../README.md#high-availability-replicas--1)) |

After install, both paths land at [§ First login](#first-login) and
[§ Behind a reverse proxy](#behind-a-reverse-proxy).

---

## A — Docker install

Production-recommended. The app is one image —
[`ghcr.io/powerdns-authadmin/powerdns-authadmin`](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pkgs/container/powerdns-authadmin) —
booted from a single `docker-compose.yml`. Five steps:
**create `.env` secrets → set `APP_URL` → write `docker-compose.yml` → start → first login.**

### Before you start

- **Docker** with the Compose plugin — `docker compose version` must be **v2+**.
- A directory to hold your two files (`.env` + `docker-compose.yml`). Everything
  below runs from inside it:

  ```sh
  mkdir powerdns-authadmin && cd powerdns-authadmin
  ```

### 1. Create `.env` (secrets)

Two secrets are **required** and must be unique to your deployment. This command
generates them, picks a bootstrap admin password, and writes `.env`. **Run it
once.**

```sh
{
  echo "APP_SECRET_KEY=$(openssl rand -base64 32)"
  echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  echo "BOOTSTRAP_ADMIN_EMAIL=admin@example.com"
  echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)"
  # Postgres only — delete this line if you chose SQLite:
  echo "POSTGRES_PASSWORD=$(openssl rand -base64 18)"
} > .env
chmod 600 .env
```

Edit `.env` and set **`BOOTSTRAP_ADMIN_EMAIL`** to your address. Note the
generated `BOOTSTRAP_ADMIN_PASSWORD` — you'll use it for the first login (and
change it immediately).

| Variable                              | Purpose                                                      | Constraint                    |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------- |
| `APP_SECRET_KEY`                      | Signs sessions, CSRF tokens, API-token HMACs                 | ≥ 32 characters               |
| `APP_ENCRYPTION_KEY`                  | Encrypts stored PowerDNS API keys, OIDC secrets, MFA secrets | base64 decoding to ≥ 32 bytes |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | The first admin account (set together)                       | password ≥ 12 chars           |

> ⚠️ **Generate the two keys once and never change them.** Rotating
> `APP_ENCRYPTION_KEY` makes every stored PowerDNS API key, OIDC secret, and MFA
> secret undecryptable; changing `APP_SECRET_KEY` logs everyone out. Back up
> `.env` — don't regenerate it. (The app refuses to start if either key is
> missing, too short, or a placeholder like `changeme`.)

Compose loads `.env` automatically, so the same values are reused on every `up`,
`down`, and restart — there are no shell `export`s to remember.

---

### 2. Set `APP_URL`

**`APP_URL` must match the URL the browser uses to reach the app — exact scheme,
host, and port.** Append it to `.env`:

```sh
echo "APP_URL=https://dns.example.com" >> .env   # ← your real public URL
```

| You access the app at…                 | Set `APP_URL` to          |
| -------------------------------------- | ------------------------- |
| `https://dns.example.com`              | `https://dns.example.com` |
| `http://10.0.0.5:3000` (LAN, no TLS)   | `http://10.0.0.5:3000`    |
| `http://localhost:3000` (local docker) | `http://localhost:3000`   |

No trailing slash. If you sit behind a reverse proxy, this is the **public**
URL, not the upstream `app:3000`.

> ⚠️ **Why this matters.** The session and CSRF cookies are scoped to
> `APP_URL`'s host. If it doesn't match the URL in your browser's address bar,
> the browser **silently rejects** the cookie (DevTools shows
> `Cookie "pda_csrf" has been rejected for invalid domain`) and sign-in fails
> with no useful error. The same value also builds OIDC redirect URIs,
> password-reset email links, and the CSP origin allowlist — getting it wrong
> breaks all three.
>
> The login page detects a mismatch on render and shows an inline error, so you
> won't have to hunt the DevTools console.

---

### 3. Write `docker-compose.yml`

Pick the block matching your database choice.

#### Option A — SQLite

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

#### Option B — Postgres

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

#### Image tags

| Tag            | Points to                                                                     |
| -------------- | ----------------------------------------------------------------------------- |
| `:latest`      | The most recent stable release. Updated only on `vX.Y.Z` tag pushes.          |
| `:X.Y`         | The latest patch in a minor channel — e.g. `:1.2` follows `1.2.0` → `1.2.1`.  |
| `:X.Y.Z`       | A single immutable release. Use this in production for deterministic deploys. |
| `:edge`        | The tip of `main`. Updates on every push; not for production.                 |
| `:sha-xxxxxxx` | An exact commit, kept forever.                                                |

Pin a version in production:

```yaml
image: ghcr.io/powerdns-authadmin/powerdns-authadmin:1.2
```

---

### 4. Start

```sh
docker compose up -d
docker compose logs -f app   # watch migrations + seed run, then "Ready"
```

Later, `docker compose down` then `up -d` reuses the same `.env` and data.
`docker compose down -v` **deletes the data volume** — only use it to start over.

---

## B — From-source install

Build the app from a checkout and run it under plain `node`. Same migrations,
same seed — just no Docker. Suitable for a VM / bare-metal install behind a
reverse proxy.

### Prerequisites

- **Node.js 24 LTS** — the `.nvmrc` pins the version; `nvm use` picks it up.
- **npm 10+** (ships with Node 24).
- **Build toolchain** for the native bindings (`better-sqlite3`, `@node-rs/argon2`):
  Debian/Ubuntu `apt-get install -y python3 build-essential`, macOS `xcode-select --install`,
  Alpine `apk add python3 make g++`.
- **Postgres 14+** if you picked that backend. (Skip for SQLite.)

### 1. Clone and install

```sh
git clone https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin.git
cd powerdns-authadmin

nvm use            # reads .nvmrc → Node 24
npm ci             # exact-pin install (incl. dev deps needed for the build)
```

### 2. Create `.env`

```sh
{
  echo "NODE_ENV=production"
  echo "APP_SECRET_KEY=$(openssl rand -base64 32)"
  echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)"
  echo "BOOTSTRAP_ADMIN_EMAIL=admin@example.com"
  echo "BOOTSTRAP_ADMIN_PASSWORD=$(openssl rand -base64 18)"
  # SQLite (single-file backend):
  echo "DATABASE_URL=file:./data/powerdns_authadmin.db"
  # OR Postgres (replace with your real connection string):
  # echo "DATABASE_URL=postgres://pdns:CHANGEME@127.0.0.1:5432/powerdns_authadmin"
} > .env
chmod 600 .env
mkdir -p data        # only for SQLite
```

The two secrets follow the same rules as the Docker path: generate once,
never rotate, back up alongside the DB.

### 3. Set `APP_URL`

Same critical step as the Docker path — see [§ A.2 Set `APP_URL`](#2-set-app_url)
for the full reasoning. Append the exact browser-visible URL:

```sh
echo "APP_URL=https://dns.example.com" >> .env   # ← match your address bar exactly
```

If you're running behind nginx/HAProxy on the same host with TLS terminated by
the proxy, set `APP_URL` to the public `https://` URL, not `http://localhost:3000`.

### 4. Build

```sh
set -a; . ./.env; set +a       # export every var in .env into the shell
npm run build                  # produces .next/standalone + .next/static
```

`npm run build` runs `next build` against the schema-typed source tree. It's
the same command Docker runs in the builder stage.

### 5. Migrate, seed, run

```sh
set -a; . ./.env; set +a
npm run db:migrate             # applies pending Drizzle migrations
npm run db:seed                # upserts system roles + bootstrap admin

npm run start                  # → http://localhost:3000
```

`npm run start` runs `next start` against the `production` build. For an
unattended install, drop it into systemd (sample unit below).

#### systemd unit

```ini
# /etc/systemd/system/powerdns-authadmin.service
[Unit]
Description=PowerDNS-AuthAdmin
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=pda
WorkingDirectory=/opt/powerdns-authadmin
EnvironmentFile=/opt/powerdns-authadmin/.env
# Adjust if node/npm aren't at /usr/bin (e.g. nvm: /home/pda/.nvm/versions/node/v24.x/bin).
Environment=PATH=/usr/local/bin:/usr/bin:/bin
# Migrations + seed are idempotent — running on every start is safe.
ExecStartPre=/usr/bin/npm run db:migrate --silent
ExecStartPre=/usr/bin/npm run db:seed --silent
ExecStart=/usr/bin/npm run start --silent
Restart=on-failure
RestartSec=5s
# Hardening (see man systemd.exec):
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/powerdns-authadmin/data
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

```sh
sudo useradd -r -s /usr/sbin/nologin pda
sudo chown -R pda:pda /opt/powerdns-authadmin
sudo systemctl daemon-reload
sudo systemctl enable --now powerdns-authadmin
sudo journalctl -fu powerdns-authadmin    # tail logs
```

Upgrade later with `git pull && npm ci && npm run build && systemctl restart
powerdns-authadmin` — migrations run on the next start.

---

## First login

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

Terminate TLS at your proxy (nginx, HAProxy, Caddy, Traefik, a cloud LB) and
forward to the app's port 3000. Three things must line up:

1. **`APP_URL` is the public, browser-visible URL** — `https://dns.example.com`,
   not the upstream `http://app:3000`. It builds OIDC redirect URIs, email
   links, cookie scope, and the CSP origin. The login page shows an inline
   error if it doesn't match the address bar (see [§ A.2](#2-set-app_url)).
2. **`X-Forwarded-Proto` and `X-Forwarded-Host`** so the app reconstructs the
   real public origin (and the APP_URL mismatch detector doesn't false-positive
   on the upstream hostname).
3. **`X-Forwarded-For` / `X-Real-IP` must be the real client IP** — the proxy
   sets/overwrites them, never appends. The app trusts these for audit + rate
   limiting; there is no `TRUST_PROXY` toggle.

#### nginx

```nginx
# /etc/nginx/sites-available/powerdns-authadmin
upstream pda_upstream {
    server 127.0.0.1:3000;
    keepalive 32;
}

# HTTP → HTTPS redirect.
server {
    listen 80;
    listen [::]:80;
    server_name dns.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name dns.example.com;

    # TLS — Let's Encrypt via certbot, or your own cert chain.
    ssl_certificate     /etc/letsencrypt/live/dns.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/dns.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # Modest upload cap — zone imports + uploaded brand logos.
    client_max_body_size 4m;

    location / {
        proxy_pass http://pda_upstream;
        proxy_http_version 1.1;

        # Public-URL reconstruction (see §3 above).
        proxy_set_header Host                $host;
        proxy_set_header X-Forwarded-Host    $host;
        proxy_set_header X-Forwarded-Proto   $scheme;

        # Client IP for audit + rate limiting (§3 above).
        # nginx automatically overwrites X-Real-IP — that's the secure default;
        # don't `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`
        # because $proxy_add_x_forwarded_for APPENDS to any client-sent value.
        proxy_set_header X-Real-IP           $remote_addr;
        proxy_set_header X-Forwarded-For     $remote_addr;

        # SSE health/realtime endpoints — disable buffering and long timeouts.
        proxy_buffering    off;
        proxy_read_timeout 5m;
        proxy_send_timeout 5m;

        # WebSocket / HTTP upgrade headers (future-proofing; harmless today).
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

`sudo nginx -t && sudo systemctl reload nginx` and you're live. With this in
place, set `APP_URL=https://dns.example.com` (not `http://localhost:3000`).

#### HAProxy

```haproxy
# /etc/haproxy/haproxy.cfg (excerpt — slot into your global/defaults)
frontend pda_https
    bind *:443 ssl crt /etc/haproxy/certs/dns.example.com.pem alpn h2,http/1.1
    bind *:80
    http-request redirect scheme https code 301 unless { ssl_fc }

    # Set the headers the app uses to reconstruct the public origin.
    http-request set-header X-Forwarded-Proto https if { ssl_fc }
    http-request set-header X-Forwarded-Proto http  if !{ ssl_fc }
    http-request set-header X-Forwarded-Host  %[req.hdr(host)]

    # Overwrite client IP headers — never trust the caller's value.
    http-request del-header  X-Forwarded-For
    http-request del-header  X-Real-IP
    http-request set-header  X-Forwarded-For %[src]
    http-request set-header  X-Real-IP       %[src]

    default_backend pda_app

backend pda_app
    option forwardfor      # disabled — we already set X-Forwarded-For above
    server pda 127.0.0.1:3000 check
    timeout server  5m     # generous: SSE realtime streams stay open
```

HAProxy expects the cert as a combined PEM (`cat fullchain.pem privkey.pem >
/etc/haproxy/certs/dns.example.com.pem`). `haproxy -c -f /etc/haproxy/haproxy.cfg`
checks the config; `systemctl reload haproxy` applies it.

#### Caddy (minimal)

```caddy
dns.example.com {
    reverse_proxy 127.0.0.1:3000 {
        header_up X-Forwarded-Proto {scheme}
        header_up X-Forwarded-Host  {host}
        # Caddy already sets X-Forwarded-For / X-Real-IP correctly.
    }
}
```

Caddy auto-provisions Let's Encrypt certs on first hit — no `ssl_certificate`
plumbing needed.

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
