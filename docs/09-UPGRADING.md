# Upgrading

PowerDNS-AuthAdmin ships as a single image and runs its own database migrations on
boot, so upgrading is usually "pull a new tag and recreate the container." This
page covers doing it safely.

## Before you upgrade

1. **Read the [CHANGELOG](../CHANGELOG.md)** for the target version — note any
   breaking changes.
2. **Back up the database** (and your `APP_ENCRYPTION_KEY`):
   - SQLite: copy the DB file / snapshot the data volume.
   - Postgres: `pg_dump`.
     See [Installation → Backups](./02-INSTALLATION.md#backups).
3. **Pin a version tag** in production rather than `:latest`, so deploys are
   deterministic and you know exactly what you're moving from and to.

## Upgrade

```sh
docker compose pull         # fetch the new image tag
docker compose up -d        # recreate the app container
docker compose logs -f app  # watch migrations apply
```

On boot the entrypoint runs migrations, then the seed (idempotent), then any
provisioning (skipped after first boot), then starts the server. Migration logs
are intentionally loud — you'll see the pending list and the applied names. If a
migration fails, **the container refuses to start** rather than running on a
half-migrated schema; fix the cause and restart.

## Verify

- `GET /readyz` returns 200 once migrations match the expected version.
- Sign in; check **Admin → PowerDNS servers** shows backends **Reachable**, and
  the dashboard has no unexpected attention banners.

## Version-specific notes

### Upgrading to 1.1.4 (from 1.1.x)

A **major operator-UX release** — drop-in upgrade. **No schema migration, no API
changes, no config changes.** Pull-and-recreate the container and you're done.

What changes when operators sign in:

- **Mobile-first responsive shell.** Every page is usable on a phone now.
  Drawer-style navigation under `md`; full sidebar from `md+`.
- **Live status chip in the top bar** — connection state plus a fleet-wide
  sync verdict (`SYNCED` / `DESYNCED`) on every page, with the per-page
  override on zone-detail / zones-list / servers preserved.
- **New animated SyncIndicator** — concentric-ring glyph used everywhere a
  sync state is displayed. Honours `prefers-reduced-motion`.
- **Diff-before-apply on every record edit.** Save is now two clicks: an
  inline edit, then a **Review changes** modal with the BIND-style diff,
  then Save.
- **One-button theme toggle** cycles light → dark → system.
- **Every list is one DataTable.** Mobile reflows to labelled cards; the
  desktop chrome is uniform across audit / zones / users / roles / teams /
  PDNS requests / OIDC / TSIG / autoprimaries / zone templates.
- **CSS-only changes** — no client-side breaking changes; saved theme
  preferences, sessions, MFA enrolments, API tokens all carry over.

If you've embedded our screenshots in your own docs, note that several
filenames changed in this release — the canonical set is now
[`screenshots/README.md`](../screenshots/README.md).

### Upgrading to 1.1.3 (from 1.1.x)

A maintenance release — **no schema migration**, a plain pull-and-recreate, and
nothing operator-facing to change. It fixes per-zone grants on multi-primary
clusters (a grant on one peer now authorizes the zone on every peer), renames the
internal request middleware to the Next 16 `proxy` convention (transparent), and
re-pins the CI GitHub Actions to Node 24 (CI-only).

### Upgrading to 1.1.2 (from 1.1.x)

A security release — **no schema migration**, a plain pull-and-recreate. Two
behavioural changes that close enforcement gaps (they may surface as a new `403`
for accounts that were previously able to bypass a gate via the API):

- **Required-MFA and forced-password-change are now enforced on the API, not just
  in the browser.** If a user's role requires MFA, or the user is flagged "must
  change password", their session is now refused on write routes until they
  enroll TOTP / change their password (the enrollment, change-password, and
  logout endpoints stay reachable). This previously only redirected the browser,
  so a direct API caller could skip it. No action needed unless you rely on
  required-MFA accounts driving the API without having enrolled — have them
  enroll.
- **Privilege ceilings are enforced on more admin paths.** Creating a user with
  an initial role, resetting another user's password, and removing another user's
  MFA now refuse to act beyond the actor's own global permissions. Operators using
  only the built-in roles are unaffected.

### Upgrading to 1.1.1 (from 1.1.0)

A maintenance + security release — **no schema migration**, so it's a plain
pull-and-recreate. One behavioural change to be aware of:

- **OIDC `requireEmailVerified` now defaults to `true`** for newly-created
  DB-backed providers (account-takeover hardening). **Existing provider rows keep
  their stored value**, so nothing changes for them on upgrade — but if you have a
  provider with `requireEmailVerified` set to `false`, audit it: confirm the IdP
  genuinely never emits the `email_verified` claim before keeping it off. See
  [OIDC](./05-OIDC.md).

Everything else in this release (the security batch, the CSP and supply-chain
hardening, and the opt-in additions like self-service signup) is transparent on
upgrade — signup stays off unless you set `SIGNUP_ENABLED=true`.

### Upgrading to 1.1.0 (from 1.0.x)

One schema migration applies on first boot (`0003_backend_caps_advisories_squash`).
It is **data-preserving** — verified end-to-end against a real 1.0.x SQLite
deployment (servers, users, roles, audit history all retained).

Two behavioural points specific to this release (ADR-0014 / ADR-0017):

- **Per-server `role` and `primary_id` are retired.** The migration drops those
  columns; a backend's primary/secondary nature is now **observed** from its
  `/config` and its primary↔secondary links **derived** from each zone's
  `masters[]`. On the first boot after upgrade, every backend's `capabilities`
  start empty and are re-populated by the first poll (seconds), so backends may
  briefly show as "unknown" until that completes. A primary + secondaries that
  was wired only by the old `primary_id` pin re-derives automatically when the
  secondary's zones list the primary's advertised address — otherwise group them
  under **Admin → Groups** (or set the primary's advertised addresses).
- **Keep your `APP_ENCRYPTION_KEY`.** Stored PDNS API keys and OIDC client
  secrets are decrypted with it; an upgrade that loses the key can't decrypt them
  (you'd see `Unsupported state or unable to authenticate data` in the logs).
  This isn't new in 1.1.0, but the backup step above is the reminder.

If you run **SQLite**, this release also requires no manual steps — the squashed
migration handles the column add/drop in one table rebuild (see
[ADR-0017](./adr/0017-migration-squash-1.1.0.md) for the SQLite-specific detail).

## Rollback

Migrations are **forward-only** — there are no automated down-migrations. To roll
back the application image you must also restore the database to its
pre-upgrade backup, because a newer migration may have changed the schema in ways
the older image doesn't understand.

```sh
# 1. stop the app   2. restore the DB backup   3. pin the previous image tag
docker compose down
# …restore Postgres dump / SQLite file…
docker compose up -d
```

This is why **the pre-upgrade backup is non-negotiable**: it's your only rollback
path.

## Multi-replica notes (Postgres)

Several replicas can boot at once — the migration step takes a `pg_advisory_lock`
so exactly one applies migrations while the others wait. Combined with `/readyz`
gating, a rolling deploy won't send traffic to a replica until its schema is
current. To run migrations as a separate pipeline step instead, set
`MIGRATE_ON_BOOT=false` and run `npm run db:migrate` before rolling the app.

For replicas > 1 you also need `REDIS_URL` set so auth rate limiting, reveal-once
tokens, and the realtime event-bus coordinate across replicas (sessions already do
— they're in Postgres). See [ADR-0016](./adr/0016-redis-horizontal-scale.md) and the
[High availability](../README.md#high-availability-replicas--1) compose example.

---

[← Docs index](./README.md)
