# PowerDNS-AuthAdmin

A modern, self-hosted DNS administration UI for **PowerDNS Authoritative** — first-class RBAC,
audit log with diffs, OIDC SSO with group→role mapping, and multi-backend management. A maintained,
modern alternative to PowerDNS-Admin.

[![CI](https://github.com/jseifeddine/powerdns-authadmin/actions/workflows/ci.yml/badge.svg)](https://github.com/jseifeddine/powerdns-authadmin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/jseifeddine/powerdns-authadmin)](https://github.com/jseifeddine/powerdns-authadmin/releases/latest)
[![License: MIT](https://img.shields.io/github/license/jseifeddine/powerdns-authadmin)](https://github.com/jseifeddine/powerdns-authadmin/blob/main/LICENSE)

![Dashboard](https://raw.githubusercontent.com/jseifeddine/powerdns-authadmin/main/screenshots/light/dashboard.png)

## What it does

- **Multi-backend** — standalone primaries, primary + secondaries groups, and multi-primary clusters
  from one app, with NOTIFY-aware sync probes.
- **RBAC** — system + custom roles, scoped global / team / zone / server.
- **Auth** — local (Argon2id), OIDC SSO with group→role mapping + RP-initiated logout, TOTP MFA,
  scoped API tokens.
- **Zones & records** — per-RRset editor with diff-before-apply, templates, DNSSEC, TSIG,
  autoprimaries.
- **Audit** — append-only log with redacted before/after diffs.
- **Storage** — SQLite or Postgres; migrations run on boot.

## Supported tags

- `latest` — newest build from `main`
- `1.0.0`, `1.0` — semver release tags
- `sha-<short>` — exact commit

## Architectures

`linux/amd64` and `linux/arm64` (multi-arch manifest).

## Quick start (SQLite)

```sh
docker run -d --name powerdns-authadmin -p 3000:3000 \
  -e APP_URL=http://localhost:3000 \
  -e DATABASE_URL=file:/data/powerdns_authadmin.db \
  -e APP_SECRET_KEY="$(openssl rand -base64 32)" \
  -e APP_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  -e BOOTSTRAP_ADMIN_EMAIL=admin@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD=change-me-now \
  -v powerdns-authadmin-data:/data \
  jseifeddine/powerdns-authadmin:latest
```

Then open <http://localhost:3000> and sign in as `admin@example.com` / `change-me-now` (you'll be
prompted to change it). Add your PowerDNS backend(s) under **Admin → PowerDNS servers**.

For a Postgres deployment, an instant demo stack (bundled PowerDNS + demo zones), the full
environment-variable reference, and SSO/SMTP setup, see the
**[GitHub repository](https://github.com/jseifeddine/powerdns-authadmin)**.

## Configuration essentials

| Variable                              | Required | What                                                        |
| ------------------------------------- | -------- | ----------------------------------------------------------- |
| `APP_URL`                             | yes      | Public URL, no trailing slash                               |
| `APP_SECRET_KEY`                      | yes      | Session/CSRF/token HMAC — `openssl rand -base64 32`         |
| `APP_ENCRYPTION_KEY`                  | yes      | AES-256 key (base64, ≥32 bytes) — `openssl rand -base64 32` |
| `DATABASE_URL`                        | yes      | `file:/data/…db` (SQLite) or `postgres://…`                 |
| `BOOTSTRAP_ADMIN_EMAIL` / `_PASSWORD` | rec.     | First SuperAdmin (password ≥12 chars)                       |
| `OIDC_*` / `SMTP_*`                   | optional | SSO / transactional email                                   |

## Links

- **Source & docs:** https://github.com/jseifeddine/powerdns-authadmin
- **Releases / changelog:** https://github.com/jseifeddine/powerdns-authadmin/releases
- **License:** MIT
