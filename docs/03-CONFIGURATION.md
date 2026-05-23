# Configuration reference

Every setting is an environment variable, validated **once at boot**. If anything
required is missing or malformed, the app refuses to start with a clear error —
misconfiguration is a startup failure, not a 3-AM surprise. The annotated source
of truth is [`.env.example`](../.env.example); this page groups the variables and
explains the ones with sharp edges.

> **`_FILE` suffix for secrets.** Any variable accepts a `<NAME>_FILE` form that
> points at a file whose contents are the value — for Docker/Kubernetes secrets:
> `APP_SECRET_KEY_FILE=/run/secrets/app_key`. If both inline and `_FILE` are set,
> the inline value wins and a warning is logged.

## Runtime

| Variable    | Default          | Notes                                                                                        |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `APP_URL`   | — (**required**) | Public, browser-visible URL. No trailing slash. Drives OIDC redirect URIs, email links, CSP. |
| `PORT`      | `3000`           | Port the server listens on.                                                                  |
| `NODE_ENV`  | `development`    | The published image runs `production`.                                                       |
| `LOG_LEVEL` | `info`           | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`.                                |

## Secrets (required)

| Variable             | Constraint          | Notes                                                                                                                           |
| -------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `APP_SECRET_KEY`     | ≥ 32 chars          | Signs sessions, CSRF tokens, API-token HMACs.                                                                                   |
| `APP_ENCRYPTION_KEY` | base64 → ≥ 32 bytes | AES-256 envelope for PowerDNS API keys + OIDC client secrets at rest. **Don't rotate** without re-entering every stored secret. |

Generate each with `openssl rand -base64 32`. Obvious placeholders are rejected.

## Database

| Variable             | Default          | Notes                                                                                                                                |
| -------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`       | — (**required**) | `file:/data/powerdns_authadmin.db` (SQLite) or `postgres://user:pass@host:5432/db`. The prefix selects the driver and migration set. |
| `DATABASE_POOL_SIZE` | `10`             | Postgres connection pool size (1–100). Ignored on SQLite.                                                                            |

## Boot stages

Read by the container entrypoint (not the app itself); all default **on**.

| Variable            | Default | Notes                                                                       |
| ------------------- | ------- | --------------------------------------------------------------------------- |
| `MIGRATE_ON_BOOT`   | `true`  | Set `false` to run `npm run db:migrate` as a separate step.                 |
| `SEED_ON_BOOT`      | `true`  | Seeds the 5 system roles + the bootstrap admin.                             |
| `PROVISION_ON_BOOT` | `true`  | Applies `PROVISIONING_FILE` once. See [Provisioning](./06-PROVISIONING.md). |
| `PROVISIONING_FILE` | unset   | Path to a first-boot YAML file. Unset = no provisioning.                    |

## Bootstrap admin

Set **both** or neither (one without the other is a startup error). Idempotent —
ensures the account exists, created with "must change password on next login".

| Variable                   | Constraint  |
| -------------------------- | ----------- |
| `BOOTSTRAP_ADMIN_EMAIL`    | valid email |
| `BOOTSTRAP_ADMIN_PASSWORD` | ≥ 12 chars  |

## Sessions

| Variable              | Default                     | Notes                                        |
| --------------------- | --------------------------- | -------------------------------------------- |
| `SESSION_TTL_SECONDS` | `43200` (12 h)              | Session lifetime.                            |
| `COOKIE_DOMAIN`       | derived from `APP_URL` host | Set explicitly only for cross-subdomain SSO. |

## Local authentication

| Variable             | Default | Notes                                                     |
| -------------------- | ------- | --------------------------------------------------------- |
| `LOCAL_AUTH_ENABLED` | `true`  | Email + password sign-in. Set `false` for SSO-only.       |
| `SIGNUP_ENABLED`     | `false` | Public self-service signup. Default: admins create users. |

## OIDC single sign-on

The `OIDC_*` variables configure a **single, read-only provider** that appears on
the login page and in **Admin → OIDC providers** badged **"Configured by ENV"** —
alongside any DB providers, not as a hidden fallback. It's edited by changing env
vars (not the UI), can't do group → role mapping, and is shadowed by a DB provider
that shares its slug. For multiple providers, icons, group → role mapping, and
per-provider options, define providers via [provisioning](./06-PROVISIONING.md) or
the admin UI.

**👉 Read [OIDC single sign-on](./05-OIDC.md) for how the env / provisioning / UI
configuration paths relate.** The env knobs:

| Variable                                   | Default                    | Notes                                                        |
| ------------------------------------------ | -------------------------- | ------------------------------------------------------------ |
| `OIDC_ENABLED`                             | `false`                    | Master switch for the env fallback provider.                 |
| `OIDC_PROVIDER_ID`                         | —                          | Slug in the callback URL: `/api/auth/oidc/<id>/callback`.    |
| `OIDC_PROVIDER_NAME`                       | —                          | Label on the login button.                                   |
| `OIDC_ISSUER_URL`                          | —                          | Issuer; the app fetches its `.well-known` discovery doc.     |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`    | —                          | OAuth client credentials.                                    |
| `OIDC_SCOPES`                              | `openid profile email`     | Space-separated.                                             |
| `OIDC_CLAIM_USERNAME` / `_EMAIL` / `_NAME` | `email` / `email` / `name` | Claim mapping.                                               |
| `OIDC_ALLOWED_EMAIL_DOMAINS`               | unset (no limit)           | Comma-separated allow-list for **new** users' email domains. |

When `OIDC_ENABLED=true`, the five required keys (`OIDC_PROVIDER_ID`,
`OIDC_PROVIDER_NAME`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)
must all be present or the app won't start. The env fallback **cannot do
group → role mapping** — that requires a DB provider.

## PowerDNS connectivity (SSRF guard)

The app re-resolves backend hostnames before each request as a DNS-rebinding
defense. Link-local addresses (incl. the `169.254.169.254` cloud-metadata IP) are
**always** blocked. See [Connecting PowerDNS backends](./04-BACKENDS.md).

| Variable                          | Default                                 | Notes                                                                                               |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_PDNS_ALLOW_PRIVATE_NETWORKS` | `false` in production, `true` otherwise | Allow PDNS URLs that resolve to loopback/RFC1918/CGNAT/ULA. Needed for in-cluster/compose PDNS.     |
| `APP_PDNS_ALLOW_INSECURE_HTTP`    | requires `https://` in production       | Allow `http://` PDNS base URLs. Both flags must be opted in for an internal `http://host:port` URL. |

## Email / SMTP (optional)

With `SMTP_HOST` unset, mail is skipped (logged) — verify-email, password reset,
and email-change links simply aren't sent. With it set, the rest must be coherent
(validated at boot). Pick **one** encryption shape.

| Variable                          | Default            | Notes                                                   |
| --------------------------------- | ------------------ | ------------------------------------------------------- |
| `SMTP_HOST`                       | unset              | Enables email when set.                                 |
| `SMTP_PORT`                       | 465/587/25 by mode | Per encryption choice below.                            |
| `SMTP_SECURE`                     | `false`            | `true` = implicit TLS (SMTPS, port 465).                |
| `SMTP_STARTTLS`                   | `opportunistic`    | `required` \| `opportunistic` \| `disabled`.            |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | unset              | Set **both** or neither (unauthenticated relay).        |
| `SMTP_FROM`                       | —                  | Envelope sender. **Required** when `SMTP_HOST` is set.  |
| `SMTP_FROM_NAME`                  | unset              | Display name.                                           |
| `SMTP_TLS_REJECT_UNAUTHORIZED`    | `true`             | `false` only for local fakemail with self-signed certs. |
| `SMTP_TIMEOUT_MS`                 | `10000`            | Per-stage timeout.                                      |

`SMTP_SECURE=true` **and** `SMTP_STARTTLS=required` together is rejected — pick one.

## Captcha — Cloudflare Turnstile (optional)

| Variable               | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `TURNSTILE_SITE_KEY`   | Renders the widget on login / forgot / change-password forms. |
| `TURNSTILE_SECRET_KEY` | Requires a verified token to submit those forms.              |

Set both for a public-facing login.

## Observability (optional)

| Variable                      | Default | Notes                                                                                               |
| ----------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `METRICS_ENABLED`             | `true`  | Exposes Prometheus `GET /metrics`. Protect it (see below).                                          |
| `METRICS_TOKEN`               | unset   | Require `Authorization: Bearer <token>` (≥ 16 chars) to scrape. Unset = open; rely on network ACLs. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset   | OTLP traces endpoint.                                                                               |

## Redis (reserved — not used yet)

| Variable    | Notes                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | **Validated but not consumed.** Rate limiting, the realtime event-bus, and reveal-once tokens are all in-process today. Setting it does **not** make the app HA across replicas; the app warns at boot when it's set. |

---

[← Docs index](./README.md)
