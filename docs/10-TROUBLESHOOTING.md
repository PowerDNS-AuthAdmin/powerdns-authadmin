# Troubleshooting

Common problems and where to look. Logs are structured (Pino) and secret-redacted
— `docker compose logs app` is your first stop for almost everything here.

## The app won't start

**`[env] Environment validation failed`** — a required variable is missing or
malformed; the message lists each offending key. Check `APP_URL` (fully-qualified,
no trailing slash), `APP_SECRET_KEY`/`APP_ENCRYPTION_KEY` (long enough, not
placeholders), and `DATABASE_URL`. See [Configuration](./03-CONFIGURATION.md).

**`OIDC_ENABLED=true but missing required keys`** — set all five:
`OIDC_PROVIDER_ID`, `OIDC_PROVIDER_NAME`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`.

**`SMTP configuration is invalid` / `BOOTSTRAP_ADMIN_* must be set together`** —
cross-field rules: `SMTP_FROM` is required with `SMTP_HOST`; `SMTP_SECURE=true`
can't combine with `SMTP_STARTTLS=required`; `SMTP_USERNAME`/`SMTP_PASSWORD` are
all-or-nothing; the two bootstrap-admin vars are all-or-nothing.

**A migration failed** — the boot aborts on purpose rather than running a
half-migrated schema. The logs print the pending migrations and where it stopped.
Fix the cause (often a DB permission or connectivity issue) and restart.

**`Build-time placeholder values detected at runtime`** — `NEXT_PHASE` is set in
the runtime env, or the deploy didn't override the secrets. Generate real
`APP_SECRET_KEY`/`APP_ENCRYPTION_KEY` and unset `NEXT_PHASE`.

## I can't reach a PowerDNS backend

- **URL rejected when adding it** — the SSRF guard blocks private-network or
  `http://` URLs by default in production. Set `APP_PDNS_ALLOW_PRIVATE_NETWORKS=true`
  and/or `APP_PDNS_ALLOW_INSECURE_HTTP=true` as needed (link-local /
  `169.254.169.254` is always blocked). See [Backends](./04-BACKENDS.md#the-ssrf-guard).
- **Status shows "Not yet reached" / dashboard flags it stale** — the app can't
  contact the API. Verify the base URL ends in `/api/v1`, the `X-API-Key` matches
  PowerDNS's `api-key`, and `webserver-allow-from` on PDNS permits the app's IP.
  Use the **Test** button for an immediate probe.
- **Reachable but no zones** — confirm `api=yes` and that the API key has access to
  the `server_id` you configured (almost always `localhost`).

## OIDC sign-in problems

- **`redirect_uri` mismatch at the IdP** — register exactly
  `<APP_URL>/api/auth/oidc/<slug>/callback`. A wrong `APP_URL` is the usual cause.
- **"Sign-in refused: not authorized"** — the email's domain isn't in the
  provider's `allowed_email_domains` (or `OIDC_ALLOWED_EMAIL_DOMAINS`), or the user
  is disabled.
- **"identity provider did not attest … verified"** — the IdP didn't send
  `email_verified: true`. Fix it at the IdP, or (DB providers only) relax
  `requireEmailVerified`.
- **Groups don't map to roles** — the env provider can't map groups; use a DB
  provider. Confirm the IdP emits the groups claim and `claim_groups` matches; the
  audit log records `auth.oidc.group_sync.mapping_unresolved` for mappings whose
  role/team/server can't be resolved.
- **My env provider isn't on the login page** — it only hides when a DB provider
  shares its slug (shadowing). See [OIDC](./05-OIDC.md#the-three-ways-to-configure-oidc--and-how-they-relate).

## Email isn't being sent

With `SMTP_HOST` unset, mail is **skipped by design** (logged, not sent) —
verify-email and reset links won't go out. Set the `SMTP_*` vars to enable it. If
set but failing, check the logs for the SMTP error and confirm the encryption mode
matches the port (465 implicit TLS vs 587 STARTTLS). See [Configuration](./03-CONFIGURATION.md#email--smtp-optional).

## I'm locked out / lost the admin

- A **failed-login lockout** auto-clears after `login_lockout_seconds` (default
  15 min).
- If a **force-default OIDC** provider is sending you straight to a broken IdP,
  append `?force-local=1` to `/login` to get the local form back.
- To re-bootstrap an admin, set `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD`
  and restart — the seed ensures that account exists (and won't clobber others).

## Re-running provisioning

Provisioning runs once (guarded by a `provisioned_at` settings row). To re-apply,
delete that row and restart — see
[Provisioning → re-apply](./06-PROVISIONING.md#it-runs-once--how-to-re-apply).

## Still stuck?

Open an issue with your logs (already secret-redacted) at
[github.com/jseifeddine/powerdns-authadmin/issues](https://github.com/jseifeddine/powerdns-authadmin/issues).
For a suspected vulnerability, follow [`SECURITY.md`](../SECURITY.md) instead.

---

[← Docs index](./README.md)
