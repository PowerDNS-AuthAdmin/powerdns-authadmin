# Hardening & best practices

A checklist for running PowerDNS-AuthAdmin safely in production. None of it is
exotic — it's the handful of things worth getting right before you expose the app.

## Secrets

- **Generate unique `APP_SECRET_KEY` and `APP_ENCRYPTION_KEY`** per deployment
  (`openssl rand -base64 32`). Never reuse the demo values from `.env.example`.
- **Treat `APP_ENCRYPTION_KEY` as un-rotatable.** It decrypts every stored
  PowerDNS API key and OIDC client secret. Rotating it strands those secrets —
  you'd have to re-enter them all. Back it up with (but stored separately from)
  your database backups.
- **Inject secrets from a secret store**, not inline env, using the `_FILE`
  suffix (`APP_SECRET_KEY_FILE=/run/secrets/...`). Works with Docker secrets and
  Kubernetes `Secret` volumes.
- **Mount provisioning files read-only, `chmod 600`.** They contain plaintext
  PowerDNS API keys and OIDC client secrets until first boot encrypts them in.

## Network exposure

- **Terminate TLS at a reverse proxy** and forward to port 3000. Set `APP_URL` to
  the public `https://` URL (no trailing slash) — it drives OIDC redirects,
  cookies, and CSP. See [Installation → reverse proxy](./02-INSTALLATION.md#behind-a-reverse-proxy).
- **Ensure the proxy overwrites `X-Forwarded-For`/`X-Real-IP`** with the real
  client IP (the app trusts these for audit + rate limiting; there's no
  `TRUST_PROXY` toggle).
- **Keep PowerDNS API endpoints private.** The API key is full control — bind the
  PDNS webserver to a private interface and restrict `webserver-allow-from`. Leave
  the SSRF guard at its strict production defaults unless you specifically need
  private-network/`http://` backends (see [Backends](./04-BACKENDS.md#the-ssrf-guard)).
- **Protect `/metrics`.** It's enabled by default — set `METRICS_TOKEN` (≥16 chars)
  to require a bearer token, or firewall the endpoint to your Prometheus host.

## Authentication

- **Require MFA where it matters.** Mark sensitive roles `requires_mfa` so holders
  must enrol TOTP. For SSO users, enforce MFA at the IdP. See [RBAC](./07-RBAC.md#mfa-required-roles).
- **Keep `SIGNUP_ENABLED=false`** (the default) unless you intend public
  self-service signup; create users via the admin UI or OIDC instead. When you do
  turn it on: keep `SIGNUP_DEFAULT_ROLE` low-privilege (the boot guard enforces
  this — see [Self-service signup](./03-CONFIGURATION.md#self-service-signup)),
  restrict who can register with `SIGNUP_ALLOWED_EMAIL_DOMAINS`, configure
  `SMTP_*` so verification links are actually delivered (signups can't log in
  until verified), and enable Turnstile to blunt automated registration.
- **Scope OIDC sign-in** with `allowed_email_domains` (per provider) or
  `OIDC_ALLOWED_EMAIL_DOMAINS` (env) so only your org's emails auto-provision.
- **Turn on Turnstile** (`TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`) for a
  public-facing login to blunt credential-stuffing.
- **Tune the lockout policy** (`login_lockout_threshold` / `login_lockout_seconds`
  settings) to taste — defaults are 10 failed attempts → 15-minute account
  lockout. (Separately, a per-IP rate limiter throttles login bursts.)

## Least privilege

- **Hand out the narrowest role + scope that works.** Prefer Zone Editor scoped to
  a zone or server over a global Operator. See [RBAC scopes](./07-RBAC.md#scopes).
- **Reserve Super Admin** for the few who run the platform. Everything is audited,
  but fewer super-admins is still fewer ways to get burned.

## Email

- **Use TLS to your SMTP relay** — `SMTP_SECURE=true` (implicit TLS, 465) or
  `SMTP_STARTTLS=required` (587). Keep `SMTP_TLS_REJECT_UNAUTHORIZED=true`; only
  disable it for a local fakemail with a self-signed cert.

## Operations

- **Run on Postgres for anything multi-instance.** Boots are serialised by an
  advisory lock so rolling deploys are safe; SQLite is single-writer.
- **Gate traffic on `/readyz`**, not just `/healthz` — it fails until migrations
  are applied, so a rolling deploy won't route to a not-ready replica.
- **Back up before upgrades** and review the [Upgrading guide](./09-UPGRADING.md).
- **Watch the audit log.** Every write is recorded with redacted before/after
  snapshots — it's your forensic trail.

---

[← Docs index](./README.md)
