# Configuration reference

Every setting is an environment variable, validated **once at boot**. If anything
required is missing or malformed, the app refuses to start with a clear error -
misconfiguration is a startup failure, not a 3-AM surprise. The annotated source
of truth is [`.env.example`](../.env.example); this page groups the variables and
explains the ones with sharp edges.

> **`_FILE` suffix for secrets.** Any variable accepts a `<NAME>_FILE` form that
> points at a file whose contents are the value - for Docker/Kubernetes secrets:
> `APP_SECRET_KEY_FILE=/run/secrets/app_key`. If both inline and `_FILE` are set,
> the inline value wins and a warning is logged.

## Runtime

| Variable    | Default          | Notes                                                                                        |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `APP_URL`   | - (**required**) | Public, browser-visible URL. No trailing slash. Drives OIDC redirect URIs, email links, CSP. |
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
| `DATABASE_URL`       | - (**required**) | `file:/data/powerdns_authadmin.db` (SQLite) or `postgres://user:pass@host:5432/db`. The prefix selects the driver and migration set. |
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

Set **both** or neither (one without the other is a startup error). Idempotent -
ensures the account exists, created with "must change password on next login".

| Variable                   | Constraint  |
| -------------------------- | ----------- |
| `BOOTSTRAP_ADMIN_EMAIL`    | valid email |
| `BOOTSTRAP_ADMIN_PASSWORD` | ≥ 12 chars  |

For a **public demo** whose login is published, set `BOOTSTRAP_ADMIN_RO=true`
(default `false`; requires `BOOTSTRAP_ADMIN_EMAIL`). It locks the bootstrap
admin's own identity and credentials - password, email, name, MFA/passkey
enrolment, disable/delete, and role changes all return 403 - so a visitor signed
in as the shared account can't hijack or lock out the login. The account can
still operate everything else (zones, other users, …); this is an identity lock,
not a global read-only mode. With it on, the seed creates the account already
compliant (`must_change_password=false`), since it can no longer change its own
password.

## Sessions

| Variable              | Default                     | Notes                                        |
| --------------------- | --------------------------- | -------------------------------------------- |
| `SESSION_TTL_SECONDS` | `43200` (12 h)              | Session lifetime.                            |
| `COOKIE_DOMAIN`       | derived from `APP_URL` host | Set explicitly only for cross-subdomain SSO. |

## Local authentication

| Variable             | Default | Notes                                               |
| -------------------- | ------- | --------------------------------------------------- |
| `LOCAL_AUTH_ENABLED` | `true`  | Email + password sign-in. Set `false` for SSO-only. |

## Self-service signup

Off by default - admins create users (or users arrive via OIDC). Turn it on only
when you want the public to register themselves. When **disabled**, both the
`/signup` page and `POST /api/auth/signup` return **404** (the feature does not
exist for the deployment) and no "Create an account" link is shown on the login
page.

| Variable                       | Default          | Notes                                                                                                   |
| ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `SIGNUP_ENABLED`               | `false`          | Master switch. `false` → `/signup` + the API are 404; admins create users.                              |
| `SIGNUP_DEFAULT_ROLE`          | `read-only`      | Role (slug) every signup receives. **Must be low-privilege** - the seed step refuses to boot otherwise. |
| `SIGNUP_ALLOWED_EMAIL_DOMAINS` | unset (no limit) | Comma-separated allow-list of email domains. Empty = any domain. Exact-domain, case-insensitive.        |

**`SMTP_*` must be configured** (see [Email / SMTP](#email--smtp-optional)) for verification
links to be **delivered**. Without SMTP the signup flow still works, but the
verification link is only recorded in the audit log (action
`auth.email.verify.sent`, field `after.url`) for an operator to share out-of-band

- the same fallback the password-reset and email-change flows use.

**Boot-time guard.** When `SIGNUP_ENABLED=true`, the seed step validates
`SIGNUP_DEFAULT_ROLE` _after_ the system roles are upserted: it must resolve to an
existing role that is **not** admin-equivalent (no `user.*`, `role.*`,
`settings.write`, `oidc.manage`, `audit.read`, `server.*`, `team.create/delete`,
or `token.*.all` permission, and never the `super-admin` slug). A missing or
over-privileged value **fails the boot loudly** rather than silently turning
public signup into an admin-account vending machine. The check is inert when
signup is off.

**End-to-end flow:**

1. Visitor opens `/signup`, enters email + password (Argon2id, min 12 chars) and
   an optional display name. Per-IP rate-limited; captcha enforced when
   `TURNSTILE_SECRET_KEY` is set.
2. The server validates input, enforces `SIGNUP_ALLOWED_EMAIL_DOMAINS`, then
   creates an **unverified** user assigned exactly `SIGNUP_DEFAULT_ROLE` (one
   audited transaction) and sends the verification link. The response is the same
   whether or not the email already exists (**no account enumeration**) - a
   duplicate silently re-sends verification to an unfinished signup.
3. The user **cannot log in until verified**: while signup is enabled, any
   unverified local account is blocked at login (`403`, `reason: email-unverified`).
   They redeem the link at `/verify-email`, which sets `email_verified_at`.
4. After verifying, they sign in normally and hold only the low-privilege default
   role. MFA is **not** required at signup; a role's MFA policy can require it
   later.

## OIDC single sign-on

The `OIDC_*` variables configure a **single, read-only provider** that appears on
the login page and in **Admin → OIDC providers** badged **"Configured by ENV"** -
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
| `OIDC_PROVIDER_ID`                         | -                          | Slug in the callback URL: `/api/auth/oidc/<id>/callback`.    |
| `OIDC_PROVIDER_NAME`                       | -                          | Label on the login button.                                   |
| `OIDC_ISSUER_URL`                          | -                          | Issuer; the app fetches its `.well-known` discovery doc.     |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`    | -                          | OAuth client credentials.                                    |
| `OIDC_SCOPES`                              | `openid profile email`     | Space-separated.                                             |
| `OIDC_CLAIM_USERNAME` / `_EMAIL` / `_NAME` | `email` / `email` / `name` | Claim mapping.                                               |
| `OIDC_ALLOWED_EMAIL_DOMAINS`               | unset (no limit)           | Comma-separated allow-list for **new** users' email domains. |

When `OIDC_ENABLED=true`, the five required keys (`OIDC_PROVIDER_ID`,
`OIDC_PROVIDER_NAME`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`)
must all be present or the app won't start. The env fallback **cannot do
group → role mapping** - that requires a DB provider.

## PowerDNS connectivity (SSRF guard)

The app re-resolves backend hostnames before each request and pins the validated
IP into the connection as a DNS-rebinding defense. Link-local addresses (incl. the
`169.254.169.254` cloud-metadata IP) are **always** blocked. See
[Connecting PowerDNS backends](./04-BACKENDS.md).

| Variable                          | Default                                 | Notes                                                                                               |
| --------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `APP_PDNS_ALLOW_PRIVATE_NETWORKS` | `false` in production, `true` otherwise | Allow PDNS URLs that resolve to loopback/RFC1918/CGNAT/ULA. Needed for in-cluster/compose PDNS.     |
| `APP_PDNS_ALLOW_INSECURE_HTTP`    | requires `https://` in production       | Allow `http://` PDNS base URLs. Both flags must be opted in for an internal `http://host:port` URL. |

### `PDNS_BACKGROUND_POLLING`

Opt-in switch for AuthAdmin's replication-awareness layer. **Defaults to
`false`** so a fresh install (or any deployment without multi-peer
topology) makes no background calls to PowerDNS - every PDNS interaction
is a direct consequence of an operator action.

When `false` (default):

- No background `setInterval`. Every PDNS call is triggered by a page
  render, a mutation, **Test**, or **Refresh All**.
- The following supplementary surfaces are **hidden**:
  - Header SYNCED / DESYNCED chip
  - Per-zone **Sync** + **Statistics** tabs
  - Servers-list **Sync** column
  - Zones-list mirror column
  - Dashboard **PowerDNS metrics** tab
  - Drift-derived advisories in the bell
- The dashboard heading carries a small `(i)` hint explaining the flag;
  a direct URL to a gated feature redirects to the default view with a
  red error toast naming this env var.
- Recommended for: single-server / standalone PowerDNS, homelab,
  small fleets where every PDNS instance is independent.

When `true`:

- The unified background poller ticks on 30 s zone-state / 60 s daemon
  refresh / 5 min metric-sample cadences against every configured
  backend.
- All replication-awareness surfaces above are visible and live.
- Required for: primary + secondaries (a primary's zones are AXFR'd to
  one or more secondaries) and multi-primary clusters (≥2 write-capable
  peers sharing storage), if you want AuthAdmin to surface drift.

The choice is process-wide; a restart applies the change. There is a
one-time boot log line at the first `/healthz` hit that summarises the
effective mode and warns when the configured fleet has replication
topology while the flag is off.

| Variable                  | Default | Notes                                                                                                   |
| ------------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `PDNS_BACKGROUND_POLLING` | `false` | Enables the background poller and all sync-aware UI. See the breakdown above for the full feature list. |

The OIDC issuer/discovery URL is operator-supplied and fetched server-side (provider
test + live discovery), so it runs through the same outbound-URL guard with its own
pair of flags. Same rule: link-local / cloud-metadata is always blocked.

| Variable                          | Default                                 | Notes                                                                                                |
| --------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `APP_OIDC_ALLOW_PRIVATE_NETWORKS` | `false` in production, `true` otherwise | Allow an OIDC issuer that resolves to a private-network address (internal IdP).                      |
| `APP_OIDC_ALLOW_INSECURE_HTTP`    | requires `https://` in production       | Allow an `http://` issuer URL. Both flags must be opted in for an internal `http://idp:port` issuer. |

## Email / SMTP (optional)

With `SMTP_HOST` unset, mail is skipped (logged) - verify-email, password reset,
and email-change links simply aren't sent. With it set, the rest must be coherent
(validated at boot). Pick **one** encryption shape.

| Variable                          | Default            | Notes                                                   |
| --------------------------------- | ------------------ | ------------------------------------------------------- |
| `SMTP_HOST`                       | unset              | Enables email when set.                                 |
| `SMTP_PORT`                       | 465/587/25 by mode | Per encryption choice below.                            |
| `SMTP_SECURE`                     | `false`            | `true` = implicit TLS (SMTPS, port 465).                |
| `SMTP_STARTTLS`                   | `opportunistic`    | `required` \| `opportunistic` \| `disabled`.            |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | unset              | Set **both** or neither (unauthenticated relay).        |
| `SMTP_FROM`                       | -                  | Envelope sender. **Required** when `SMTP_HOST` is set.  |
| `SMTP_FROM_NAME`                  | unset              | Display name.                                           |
| `SMTP_TLS_REJECT_UNAUTHORIZED`    | `true`             | `false` only for local fakemail with self-signed certs. |
| `SMTP_TIMEOUT_MS`                 | `10000`            | Per-stage timeout.                                      |

`SMTP_SECURE=true` **and** `SMTP_STARTTLS=required` together is rejected - pick one.

## Captcha - Cloudflare Turnstile (optional)

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

## Redis - horizontal scale (optional)

Setting `REDIS_URL` makes three otherwise per-process pieces of state coordinate
across replicas: auth rate limiting, the realtime SSE event-bus, and reveal-once
tokens. Sessions are already shared (they live in Postgres). Each piece falls back
to its in-process path if Redis is unset **or** a command fails, so a single node
needs no Redis and a Redis blip degrades coordination rather than causing an outage.

| Variable    | Default | Notes                                                                                                                                                   |
| ----------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL` | unset   | Enables cross-replica coordination. **Required** for replicas > 1, alongside a shared Postgres `DATABASE_URL`. SQLite is single-instance. See ADR-0016. |

See the [High availability](../README.md#high-availability-replicas--1) section for a
Postgres + Redis compose example.

---

[← Docs index](./README.md)
