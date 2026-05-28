# Upgrading

Operator-facing notes for upgrades that need more than a `docker compose pull`.
The CHANGELOG carries the per-version summary; this file documents the
**actions an operator might need to take** when crossing a version boundary.

---

## Upgrading to v1.3.0

v1.3.0 is a feature-pile release: WebAuthn, SAML, LDAP, teams zone grants,
session-scoped IdP-derived permissions, plus a unified `/admin/authentication`
admin surface. The migration is a single SQL file per dialect
(`drizzle/0004_*.sql` + `drizzle-sqlite/0004_*.sql`) and runs automatically
at app boot — no manual steps for the schema.

The list below covers items that need operator attention.

### Permission rename — `oidc.*` → `auth.*`

The `oidc.read` / `oidc.manage` permission strings are renamed to `auth.read` /
`auth.manage` since the same gates now cover OIDC, SAML, and LDAP at the
unified `/admin/authentication` surface.

**What the migration does for you**: existing `roles.permissions` arrays are
rewritten in place — every `"oidc.read"` becomes `"auth.read"`, every
`"oidc.manage"` becomes `"auth.manage"`. Seeded system roles + custom
operator-defined roles both get the update.

**What you need to do**: nothing in the typical case. If you provision roles
declaratively via `provisioning.yaml`, update your YAML to use the new
permission names — the applier won't fail on the old names, but they'll be
silently dropped (they're no longer in the master vocabulary).

### Admin URL renames — `/admin/oidc-providers` → `/admin/authentication/oidc`

URLs:

| Old                          | New                                  |
| ---------------------------- | ------------------------------------ |
| `/admin/oidc-providers`      | `/admin/authentication/oidc`         |
| `/admin/oidc-providers/<id>` | `/admin/authentication/oidc/<id>`    |
| `/admin/saml-providers`      | `/admin/authentication/saml`         |
| `/admin/saml-providers/<id>` | `/admin/authentication/saml/<id>`    |
| `/admin/ldap-providers`      | `/admin/authentication/ldap`         |
| `/admin/ldap-providers/<id>` | `/admin/authentication/ldap/<id>`    |

Every old URL keeps a server-side redirect to the new one, so external links,
bookmarks, and audit-log references continue to resolve. Update your own docs
+ runbooks at your leisure.

The internal API routes (`/api/admin/oidc-providers/...` etc.) are **not**
moved — they're a stable contract for any external automation you might have.

### IdP-derived permissions move from `role_assignments` to `sessions`

**The breaking-ish bit**: rows in `role_assignments` that were tagged with
`provider_id` (i.e. they came from an OIDC group-sync) are deleted by the
migration. They re-materialise into the user's new
`sessions.derived_permissions` JSONB column on their **next sign-in**.

**Why**: persisting IdP-derived rows left stale state for users who'd been
removed from groups but never signed in again. The new model keeps a
derived-perms snapshot on the session row; tokens live-recompute against
the IdP at use time (LDAP service account search, OIDC refresh-token →
userinfo) bounded by `IDP_PERMS_CACHE_TTL_SECONDS` (default 60s) or fall
back to the latest session snapshot up to `TOKEN_IDP_FALLBACK_TTL_SECONDS`
(default 24h) when the IdP can't be reached. See issue #85 for the full
design.

**What operators experience**:

* Local-auth users: nothing changes.
* SSO users with an active session at upgrade time: their session keeps its
  admin-issued permissions. They temporarily lose their IdP-derived perms
  until they sign in again, which re-materialises the snapshot onto the
  session row. Sign-out / sign-in once after the upgrade.
* SSO users with API tokens: same — token use falls back to admin-issued
  perms until the user re-signs-in (and within 60s after that, the live
  recompute kicks in for LDAP / OIDC sessions).

**New env vars** (both optional, sensible defaults):

```env
# How old the latest session's IdP-derived snapshot is allowed to be before
# tokens drop the IdP-derived slice (default 24h).
TOKEN_IDP_FALLBACK_TTL_SECONDS=86400

# Cache window for the live IdP-perms recompute (LDAP/OIDC). Lower → tighter
# freshness, more IdP load. Default 60s.
IDP_PERMS_CACHE_TTL_SECONDS=60
```

### OIDC sessions: enable `offline_access` for live token recompute

To get the OIDC live-recompute path (refresh-token → userinfo at API-token
use time), the IdP must include `offline_access` in the scope on the
authorization request — which is already the default for new OIDC providers
configured under `/admin/authentication/oidc`. **Existing OIDC sessions
created before the upgrade have no refresh token stored**; their tokens use
the session-snapshot fallback until the user signs in fresh.

Action: existing OIDC operators should sign out + sign in once after the
upgrade if they want their tokens to enjoy the live-recompute path.

### Audit-action vocabulary changes

Renamed / removed:

| Old                                            | New                                |
| ---------------------------------------------- | ---------------------------------- |
| `auth.oidc.group_sync.assignment_added`        | _removed_ (no per-row events now)  |
| `auth.oidc.group_sync.assignment_removed`      | _removed_                          |
| `auth.oidc.group_sync.mapping_unresolved`      | `auth.group_sync.mapping_unresolved` |
| `auth.oidc.linked`                             | `auth.idp.linked`                  |
| `auth.oidc.rejected_provisioning`              | `auth.idp.rejected_provisioning`   |
| `auth.saml.linked`                             | `auth.idp.linked`                  |
| `auth.saml.rejected_provisioning`              | `auth.idp.rejected_provisioning`   |
| `auth.ldap.rejected_provisioning`              | `auth.idp.rejected_provisioning`   |

Existing audit log rows are **untouched** — old action names stay on the
rows that were written under them. The vocabulary change only affects new
rows. Audit search dashboards that filter on the old action names should be
updated.

### Backup admin (super-admin only)

A new `/admin/backup` page exposes a JSON export of the app DB. Permission:
the new `system.backup`, default-granted only to the seeded `super-admin`
role. The export excludes PDNS zone data and the symmetric secrets
(`APP_SECRET_KEY` / `APP_ENCRYPTION_KEY`) — encrypted columns are exported
as ciphertext, useless without the encryption key on the restore target.

Restoring is documented on the admin page; the interactive restore UI lands
in a follow-up.
