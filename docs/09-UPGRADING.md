# Upgrading

PowerDNS-AuthAdmin ships as a single image and runs its own database migrations on
boot, so upgrading is usually "pull a new tag and recreate the container." This
page covers doing it safely.

## Before you upgrade

1. **Read the [CHANGELOG](../CHANGELOG.md)** for the target version - note any
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
are intentionally loud - you'll see the pending list and the applied names. If a
migration fails, **the container refuses to start** rather than running on a
half-migrated schema; fix the cause and restart.

## Verify

- `GET /readyz` returns 200 once migrations match the expected version.
- Sign in; check **Admin → PowerDNS servers** shows backends **Reachable**, and
  the dashboard has no unexpected attention banners.

## Version-specific notes

### Upgrading to 1.4.1 (from 1.4.0)

No migration and no breaking changes - pull the new tag and recreate the container
as above. The release fixes create-zone template auto-selection for clustered /
grouped primaries, clarifies the backend picker's group label, and adds an opt-in
Settings read-only lock.

#### Optional - lock the Settings page for public demos (`SETTINGS_RO`)

If you run a **publicly-reachable demo** where visitors may hold a settings-capable
role, set `SETTINGS_RO=true` to make the entire admin Settings page read-only: every
runtime-mutable setting is frozen and `PATCH /api/admin/settings` returns 403 even
for holders of `settings.write`. Leave it unset (`false`, the default) for normal
deployments - existing behaviour is unchanged. It needs no companion variable.

### Upgrading to 1.4.0 (from 1.3.x)

No migration and no breaking changes - pull the new tag and recreate the
container as above. The release adds an opt-in demo guard rail and dashboard
fixes.

#### Optional - lock the bootstrap admin for public demos (`BOOTSTRAP_ADMIN_RO`)

If you run a **publicly-reachable demo** with a published login, set
`BOOTSTRAP_ADMIN_RO=true` (and make sure `BOOTSTRAP_ADMIN_EMAIL` is set). This
freezes that account's own password, email, name, MFA / passkey, enable/disable,
delete, and role assignments, so a visitor can't hijack or lock out the shared
login. It changes nothing else the account can do. Leave it unset (`false`, the
default) for normal deployments - existing behaviour is unchanged. When enabled,
the seed provisions the account already password-compliant, so the first login
isn't trapped on a change-password screen it can never clear.

### Upgrading to 1.3.0 (from 1.2.x)

A **feature-pile release**: WebAuthn (passkeys, primary + 2FA), SAML 2.0 SP,
LDAP direct-bind, teams per-zone grants, session-scoped IdP-derived
permissions with live token recompute, the unified `/admin/authentication`
admin surface, and a super-admin Backup & Restore wizard. The migration is a
single SQL file per dialect (`drizzle/0004_low_luminals.sql` +
`drizzle-sqlite/0004_black_storm.sql`) and runs automatically at app boot -
no manual schema steps.

The items below need operator attention.

#### Permission rename - `oidc.*` → `auth.*`

The `oidc.read` / `oidc.manage` permission strings are renamed to `auth.read` /
`auth.manage` since the same gates now cover OIDC, SAML, and LDAP at the
unified `/admin/authentication` surface.

**What the migration does for you**: existing `roles.permissions` arrays are
rewritten in place - every `"oidc.read"` becomes `"auth.read"`, every
`"oidc.manage"` becomes `"auth.manage"`. Seeded system roles + custom
operator-defined roles both get the update.

**What you need to do**: nothing in the typical case. If you provision roles
declaratively via `provisioning.yaml`, update your YAML to use the new
permission names - the applier won't fail on the old names, but they'll be
silently dropped (they're no longer in the master vocabulary).

#### Admin URL renames - `/admin/oidc-providers` → `/admin/authentication/oidc`

| Old                          | New                               |
| ---------------------------- | --------------------------------- |
| `/admin/oidc-providers`      | `/admin/authentication/oidc`      |
| `/admin/oidc-providers/<id>` | `/admin/authentication/oidc/<id>` |
| `/admin/saml-providers`      | `/admin/authentication/saml`      |
| `/admin/saml-providers/<id>` | `/admin/authentication/saml/<id>` |
| `/admin/ldap-providers`      | `/admin/authentication/ldap`      |
| `/admin/ldap-providers/<id>` | `/admin/authentication/ldap/<id>` |

Every old URL keeps a server-side redirect to the new one, so external links,
bookmarks, and audit-log references continue to resolve. Update your own docs
and runbooks at your leisure. The internal API routes
(`/api/admin/oidc-providers/...` etc.) are **not** moved - they're a stable
contract for external automation.

#### IdP-derived permissions move from `role_assignments` to `sessions`

**The breaking-ish bit**: rows in `role_assignments` tagged with `provider_id`
(i.e. they came from an OIDC group-sync) are deleted by the migration. They
re-materialise into the user's new `sessions.derived_permissions` JSONB column
on their **next sign-in**.

**Why**: persisting IdP-derived rows left stale state for users removed from
groups who never signed in again. The new model keeps a derived-perms snapshot
on the session row; tokens live-recompute against the IdP at use time (LDAP
service-account search, OIDC refresh-token → userinfo) bounded by
`IDP_PERMS_CACHE_TTL_SECONDS` (default 60s) or fall back to the latest session
snapshot up to `TOKEN_IDP_FALLBACK_TTL_SECONDS` (default 24h) when the IdP
can't be reached. See issue #85 for the full design.

**What operators experience**:

- Local-auth users: nothing changes.
- SSO users with an active session at upgrade time: the session keeps its
  admin-issued permissions. They temporarily lose IdP-derived perms until they
  sign in again, which re-materialises the snapshot. Sign-out / sign-in once
  after the upgrade.
- SSO users with API tokens: same - token use falls back to admin-issued perms
  until the user re-signs-in (then within 60s the live recompute kicks in for
  LDAP / OIDC sessions).

**New env vars** (both optional, sensible defaults):

```env
# How old the latest session's IdP-derived snapshot may be before tokens drop
# the IdP-derived slice (default 24h).
TOKEN_IDP_FALLBACK_TTL_SECONDS=86400

# Cache window for the live IdP-perms recompute (LDAP/OIDC). Lower → tighter
# freshness, more IdP load. Default 60s.
IDP_PERMS_CACHE_TTL_SECONDS=60
```

#### OIDC sessions: enable `offline_access` for live token recompute

To get the OIDC live-recompute path (refresh-token → userinfo at API-token use
time), the IdP must include `offline_access` in the scope on the authorization
request - already the default for new OIDC providers configured under
`/admin/authentication/oidc`. **Existing OIDC sessions created before the
upgrade have no refresh token stored**; their tokens use the session-snapshot
fallback until the user signs in fresh. Existing OIDC operators should sign
out + sign in once after the upgrade to enjoy the live-recompute path.

#### Session TTL is now bounds-checked

`SESSION_TTL_SECONDS` is clamped to `[300, 2592000]` (5 minutes – 30 days) at
boot. If you'd set a value outside that window (almost certainly a typo), the
app now refuses to start with a clear error rather than silently logging
everyone out or accumulating session rows without a ceiling. Default is
unchanged (43200 = 12h).

#### Audit-action vocabulary changes

| Old                                       | New                                  |
| ----------------------------------------- | ------------------------------------ |
| `auth.oidc.group_sync.assignment_added`   | _removed_ (no per-row events now)    |
| `auth.oidc.group_sync.assignment_removed` | _removed_                            |
| `auth.oidc.group_sync.mapping_unresolved` | `auth.group_sync.mapping_unresolved` |
| `auth.oidc.linked`                        | `auth.idp.linked`                    |
| `auth.oidc.rejected_provisioning`         | `auth.idp.rejected_provisioning`     |
| `auth.saml.linked`                        | `auth.idp.linked`                    |
| `auth.saml.rejected_provisioning`         | `auth.idp.rejected_provisioning`     |
| `auth.ldap.rejected_provisioning`         | `auth.idp.rejected_provisioning`     |

Existing audit rows are **untouched** - old action names stay on the rows
written under them. The change only affects new rows. Audit dashboards that
filter on the old names should be updated.

#### Backup & Restore (super-admin only)

A new **Backup & Restore** wizard at `/admin/settings/backup` exposes a JSON
export of the app DB **and** a merge-mode restore (insert-missing-rows only,
guarded by a typed confirmation phrase). Permission: the new `system.backup`,
default-granted only to the seeded `super-admin` role. The export excludes
PDNS zone data and the symmetric secrets (`APP_SECRET_KEY` /
`APP_ENCRYPTION_KEY`); encrypted columns export as ciphertext, useless without
the encryption key on the restore target.

#### Zone Import / Export

A new **Import / Export** hub at `/admin/import-export` (under PowerDNS →
Zones) lets operators paste/upload BIND zonefiles to create zones in bulk, and
download selected zones as a single BIND-format bundle. `zone.read` to view,
`zone.create` to import. No operator action required - it's additive.

### Upgrading to 1.2.1 (from 1.2.x)

A **build-pipeline patch** - drop-in upgrade. No schema, no API, no
operator-config changes. Pull-and-recreate the container:

```sh
docker compose pull && docker compose up -d
```

What changes:

- **Image is significantly smaller.** ~1.18 GB → ~290 MB local
  (-75%); the compressed pull from GHCR drops from ~225 MB to ~80 MB
  (-65%). Pull time on a rolling deploy drops accordingly.
- **No `tsx`, no `/app/scripts/`, `/app/lib/`, or `/app/tsconfig.json`
  in the runtime image.** Boot stages run pre-bundled ESM files under
  `/app/boot/{migrate,seed,provision}.js`.
- **Runner is now distroless.** Base swapped from
  `node:24-bookworm-slim` to `gcr.io/distroless/nodejs24-debian12:nonroot`.
  No shell, no apt, no package manager in the runtime image - only
  `node`, glibc, openssl, ca-certificates.
- **Container user is `nonroot` (uid 65532)**, replacing `node`
  (uid 1000).
- **Next.js built-in image optimizer is disabled** (`images.unoptimized: true`);
  `<Image>` tags still render at intrinsic size.
- **`:latest` follows releases**, not `main`. `:edge` tracks `main`.
  See [Installation → Image tags](./02-INSTALLATION.md#image-tags).

> **NOTE - operator-facing trade-offs (read before upgrading a
> production deployment):**
>
> 1.  **No shell in the runtime container.** `docker exec <id> sh` is
>     unavailable; the distroless base ships only the Node binary.
>     For incident triage that needs a shell, build a `:debug` tag
>     against the same builder stage with a bookworm-slim runner.
>     Day-to-day operations (logs, `/healthz`, `/readyz`, env reload,
>     image upgrades) are unaffected.
> 2.  **Container user changed from `node` (uid 1000) to `nonroot`
>     (uid 65532).** If you'd manually chown'd a host-mounted `/data`
>     volume to uid 1000 prior, re-chown it to 65532 before the first
>     boot of v1.2.1. The compose examples shipped in this repo don't
>     pin a uid and need no change.

If you mounted anything inside the image at one of the dropped paths
(`/app/scripts`, `/app/lib`, `/app/tsconfig.json`) for custom tooling,
that's the only meaningful breakage - those are build-time artefacts
and shouldn't be mounted in production, but the upgrade now enforces
it.

### Upgrading to 1.2.0 (from 1.1.x)

A **minor release** - no schema migration, no API changes, drop-in upgrade.
There is **one new env var with a behaviour-change default**, and a fix for
operators running standalone PowerDNS.

> **NOTE: This release introduces `PDNS_BACKGROUND_POLLING` which defaults to `false`.**
> If you currently rely on the SYNCED/DESYNCED chip, the dashboard
> "PowerDNS metrics" tab, the per-zone "Sync" or "Statistics" tabs, the
> servers-list Sync column, the zones-list mirror column, or drift-derived
> advisories in the bell, **you MUST NOW ENABLE** `PDNS_BACKGROUND_POLLING=true`
> in your environment and restart the app to keep those surfaces working.
> With the flag at its default (`false`), all of those features hide;
> the rest of AuthAdmin (zones, records, DNSSEC, TSIG, autoprimaries,
> audit, RBAC, OIDC, signup) is unchanged.

What also changes after the upgrade:

- **Standalone PDNS Auth instances (no `primary=yes` or `secondary=yes`
  in `pdns.conf`) become usable as zone-create targets.** Until 1.2.0,
  AuthAdmin was treating "no replication flag set" as "not writable" -
  hiding the backend from `/zones/new`'s picker even though **Test**
  went green. After upgrading those backends appear on the create-zone
  page automatically; nothing to reconfigure. (Closes #57.)
- **Capability badge `none` → `standalone`** for those backends. Same
  neutral tone, accurate label.
- If you applied the **`primary=yes` workaround** mentioned in #57 to
  unblock zone creation on a standalone, you can now revert it from
  `pdns.conf`. The override was operationally harmless either way - no
  slaves to NOTIFY - but the badge will read `standalone` correctly
  once it's gone.

#### Choosing your `PDNS_BACKGROUND_POLLING` value

| Deployment shape                                                          | Set `PDNS_BACKGROUND_POLLING` to     |
| ------------------------------------------------------------------------- | ------------------------------------ |
| Single PowerDNS server / standalone / homelab - no AXFR replication.      | `false` (the new default - leave it) |
| Multiple standalone PowerDNS instances, none acting as primary/secondary. | `false`                              |
| One primary with one or more secondaries replicating its zones via AXFR.  | `true` _(strongly recommended)_      |
| Two or more PowerDNS instances forming a multi-primary cluster.           | `true` _(strongly recommended)_      |

**With `PDNS_BACKGROUND_POLLING=false` (default):**

- AuthAdmin contacts PDNS only in direct response to operator actions:
  page renders, **Test**, **Refresh All**, zone create/edit/delete,
  DNSSEC/TSIG/autoprimaries actions. No background traffic.
- The supplementary "replication-awareness" surfaces are hidden - see
  the list under "MUST NOW ENABLE" above.
- The dashboard renders the Admin view only; a small `(i)` icon by the
  page heading explains how to enable polling.
- Operator clicks on a direct URL to a gated feature get a red error
  toast naming the env var.

**With `PDNS_BACKGROUND_POLLING=true`:**

- The unified background poller runs on its 30 s / 60 s / 5 min
  cadences against every configured backend.
- All replication-awareness features are visible and live:
  - SYNCED / DESYNCED chip in the top header (per-page where
    relevant; fleet-wide on most pages).
  - **Sync** + **Statistics** tabs on every zone-detail page.
  - **Sync** column on `/admin/servers`.
  - Mirror column on `/zones`.
  - **PowerDNS metrics** tab on the dashboard, including the live
    time-series charts (query rate, latency, cache hit, response
    composition by qtype/rcode/size).
  - Drift-derived advisories surfaced in the bell.
- A boot-time log line confirms the mode and (when off) whether the
  configured fleet looks like it would benefit from being on.

At the moment of the upgrade decision: most single-PowerDNS / small
deployments will get a quieter, friendlier experience by leaving the
flag at its default. Multi-replica and clustered operators will want
to set it `true` immediately and restart so AuthAdmin's full
operational surface is back.

### Upgrading to 1.1.5 (from 1.1.x)

A **security-hygiene patch.** No app-code changes; no schema, API, or
config changes. Pull-and-recreate.

Adds a defensive `package.json` `overrides` pin keeping `size-sensor` at
`1.0.3` (the last clean version) - closes the resolver attack window for
the **Mini Shai-Hulud** npm campaign that hijacked `size-sensor` `1.0.4`
/ `1.1.4` / `1.2.4` on 2026-05-19. **PowerDNS-AuthAdmin was never
shipped with the affected versions**; this release just locks the door.
See the [Security Advisory](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/security/advisories)
and `MAL-2026-4153` / `GHSA-gx6x-v325-85g4` for the threat detail.

### Upgrading to 1.1.4 (from 1.1.x)

A **major operator-UX release** - drop-in upgrade. **No schema migration, no API
changes, no config changes.** Pull-and-recreate the container and you're done.

What changes when operators sign in:

- **Mobile-first responsive shell.** Every page is usable on a phone now.
  Drawer-style navigation under `md`; full sidebar from `md+`.
- **Live status chip in the top bar** - connection state plus a fleet-wide
  sync verdict (`SYNCED` / `DESYNCED`) on every page, with the per-page
  override on zone-detail / zones-list / servers preserved.
- **New animated SyncIndicator** - concentric-ring glyph used everywhere a
  sync state is displayed. Honours `prefers-reduced-motion`.
- **Diff-before-apply on every record edit.** Save is now two clicks: an
  inline edit, then a **Review changes** modal with the BIND-style diff,
  then Save.
- **One-button theme toggle** cycles light → dark → system.
- **Every list is one DataTable.** Mobile reflows to labelled cards; the
  desktop chrome is uniform across audit / zones / users / roles / teams /
  PDNS requests / OIDC / TSIG / autoprimaries / zone templates.
- **CSS-only changes** - no client-side breaking changes; saved theme
  preferences, sessions, MFA enrolments, API tokens all carry over.

If you've embedded our screenshots in your own docs, note that several
filenames changed in this release - the canonical set is now
[`screenshots/README.md`](../screenshots/README.md).

### Upgrading to 1.1.3 (from 1.1.x)

A maintenance release - **no schema migration**, a plain pull-and-recreate, and
nothing operator-facing to change. It fixes per-zone grants on multi-primary
clusters (a grant on one peer now authorizes the zone on every peer), renames the
internal request middleware to the Next 16 `proxy` convention (transparent), and
re-pins the CI GitHub Actions to Node 24 (CI-only).

### Upgrading to 1.1.2 (from 1.1.x)

A security release - **no schema migration**, a plain pull-and-recreate. Two
behavioural changes that close enforcement gaps (they may surface as a new `403`
for accounts that were previously able to bypass a gate via the API):

- **Required-MFA and forced-password-change are now enforced on the API, not just
  in the browser.** If a user's role requires MFA, or the user is flagged "must
  change password", their session is now refused on write routes until they
  enroll TOTP / change their password (the enrollment, change-password, and
  logout endpoints stay reachable). This previously only redirected the browser,
  so a direct API caller could skip it. No action needed unless you rely on
  required-MFA accounts driving the API without having enrolled - have them
  enroll.
- **Privilege ceilings are enforced on more admin paths.** Creating a user with
  an initial role, resetting another user's password, and removing another user's
  MFA now refuse to act beyond the actor's own global permissions. Operators using
  only the built-in roles are unaffected.

### Upgrading to 1.1.1 (from 1.1.0)

A maintenance + security release - **no schema migration**, so it's a plain
pull-and-recreate. One behavioural change to be aware of:

- **OIDC `requireEmailVerified` now defaults to `true`** for newly-created
  DB-backed providers (account-takeover hardening). **Existing provider rows keep
  their stored value**, so nothing changes for them on upgrade - but if you have a
  provider with `requireEmailVerified` set to `false`, audit it: confirm the IdP
  genuinely never emits the `email_verified` claim before keeping it off. See
  [OIDC](./05-OIDC.md).

Everything else in this release (the security batch, the CSP and supply-chain
hardening, and the opt-in additions like self-service signup) is transparent on
upgrade - signup stays off unless you set `SIGNUP_ENABLED=true`.

### Upgrading to 1.1.0 (from 1.0.x)

One schema migration applies on first boot (`0003_backend_caps_advisories_squash`).
It is **data-preserving** - verified end-to-end against a real 1.0.x SQLite
deployment (servers, users, roles, audit history all retained).

Two behavioural points specific to this release (ADR-0014 / ADR-0017):

- **Per-server `role` and `primary_id` are retired.** The migration drops those
  columns; a backend's primary/secondary nature is now **observed** from its
  `/config` and its primary↔secondary links **derived** from each zone's
  `masters[]`. On the first boot after upgrade, every backend's `capabilities`
  start empty and are re-populated by the first poll (seconds), so backends may
  briefly show as "unknown" until that completes. A primary + secondaries that
  was wired only by the old `primary_id` pin re-derives automatically when the
  secondary's zones list the primary's advertised address - otherwise group them
  under **Admin → Clusters** (or set the primary's advertised addresses).
- **Keep your `APP_ENCRYPTION_KEY`.** Stored PDNS API keys and OIDC client
  secrets are decrypted with it; an upgrade that loses the key can't decrypt them
  (you'd see `Unsupported state or unable to authenticate data` in the logs).
  This isn't new in 1.1.0, but the backup step above is the reminder.

If you run **SQLite**, this release also requires no manual steps - the squashed
migration handles the column add/drop in one table rebuild (see
[ADR-0017](./adr/0017-migration-squash-1.1.0.md) for the SQLite-specific detail).

## Rollback

Migrations are **forward-only** - there are no automated down-migrations. To roll
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

Several replicas can boot at once - the migration step takes a `pg_advisory_lock`
so exactly one applies migrations while the others wait. Combined with `/readyz`
gating, a rolling deploy won't send traffic to a replica until its schema is
current. To run migrations as a separate pipeline step instead, set
`MIGRATE_ON_BOOT=false` and run `npm run db:migrate` before rolling the app.

For replicas > 1 you also need `REDIS_URL` set so auth rate limiting, reveal-once
tokens, and the realtime event-bus coordinate across replicas (sessions already do

- they're in Postgres). See [ADR-0016](./adr/0016-redis-horizontal-scale.md) and the
  [High availability](../README.md#high-availability-replicas--1) compose example.

---

[← Docs index](./README.md)
