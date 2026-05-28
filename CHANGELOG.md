# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — targeting v1.3.0

A major feature pile: WebAuthn primary + 2FA, SAML 2.0 SP, LDAP direct-bind,
teams zone grants, session-scoped IdP-derived permissions with live token
recompute, the unified `/admin/authentication` admin surface, and a new
super-admin-gated app-DB backup export. See [`UPGRADING.md`](./UPGRADING.md)
for operator actions.

**Migration**: one new SQL file per dialect (`drizzle/0004_*.sql` and
`drizzle-sqlite/0004_*.sql`). Runs at boot.

### Added — teams: per-zone grants (#75)

`zone_grants` now supports a team principal alongside the existing user
principal. A grant attached to a team flows through to every member via
`team_members`; revoking the grant or removing a member from the team
revokes access without surgery on per-user rows. Same admin surface as
user grants (`/admin/teams/[id]` gets a Zone-grants section). Cross-type
duplicate prevention via partial unique indexes; exactly-one principal
enforced by a CHECK constraint.

### Added — session-scoped IdP-derived permissions + live token recompute (#85)

IdP groups stop materialising into persistent `role_assignments` rows.
At sign-in, the user's group claim is resolved to an
`AbilitySource[]` snapshot via the new `computeGroupSync` and stored on
`sessions.derived_permissions` (new JSONB column). Sessions naturally
expire; stale grants for inactive users disappear with the session.

Tokens follow current real permissions. At token use time, an OIDC or
LDAP user's groups are re-fetched live (LDAP service-account search,
OIDC refresh-token → userinfo) and materialised through the same
`computeGroupSync`, cached per `IDP_PERMS_CACHE_TTL_SECONDS` (default
60s). Fallback path: when the live recompute fails (IdP unreachable,
refresh rejected, SAML — which has no back-channel), the token uses
the latest session's snapshot bounded by `TOKEN_IDP_FALLBACK_TTL_SECONDS`
(default 24h). New audit action `auth.token.idp_perms_refreshed` —
one row per cache window.

### Added — zone detail "Access" tab (#76)

New "Access" tab on `/zones/[id]` (gated on `user.read`) listing every
principal with access to the zone: roles that grant any zone-scope
permission (dynamically derived from each role's permission list —
system roles surface naturally, custom roles too if the operator gave
them zone perms), teams with explicit `zone_grants` on this zone, and
users with direct grants.

### Added — tabbed admin user-edit (#79)

`/admin/users/[id]` matches `/profile`'s tab vocabulary (Account / Roles /
Zone grants / Sessions / Two-factor / API tokens / Audit) instead of a
long scroll. Tabs gated on the actor's capabilities. Self-edit
server-redirects to `/profile` (the admin user-detail URL never enters
history — Back returns to the users list cleanly).

### Added — app-DB backup export (#84)

Super-admin-gated **Backup & Restore** wizard under
`/admin/settings/backup` (no modal — every step renders inline with a
back button). `GET /api/admin/backup/export` streams a JSON dump of the
app DB; `POST /api/admin/backup/restore` does a merge-mode restore
(`INSERT … ON CONFLICT DO NOTHING` in forward-FK order, one
transaction, typed `RESTORE` confirmation phrase). Excludes PDNS zone
data and symmetric secrets (`APP_SECRET_KEY` / `APP_ENCRYPTION_KEY`);
encrypted columns ride as ciphertext — useless without the encryption
key on the restore target. New `system.backup` permission,
default-granted only to the seeded Super Admin role. Audit:
`system.backup.exported` / `system.backup.restored` with per-table
row counts.

### Added — zone Import / Export (#9)

New **Import / Export** hub under **PowerDNS → Zones**
(`/admin/import-export`, `zone.read` to view, `zone.create` to import):

- **Import** — paste one or many zones in BIND format (or load from a
  file). A new RFC 1035 parser (`lib/dns/zonefile-parser.ts`) splits
  multi-zone input at `$ORIGIN` boundaries, handles `$TTL`, `@`,
  comments, and parenthesised multi-line SOA, refuses `$INCLUDE`
  (file-traversal vector), and skips DNSSEC types (PDNS manages those).
  Each zone becomes one `createZone` call with its rrsets pre-populated;
  the result is reported per-zone (created / failed + parse diagnostics).
  Audit: one `zone.create` row per imported zone (`source: zonefile-import`).
- **Export** — pick a backend, multi-select zones, download a single
  BIND-format text bundle. The serializer (`lib/dns/zonefile.ts`, from
  the per-zone export route) emits idiomatic `$TTL` + `$ORIGIN`,
  owner names relativised against the origin (apex → `@`), and a
  parenthesised multi-line SOA; output round-trips through BIND / NSD /
  `pdnsutil load-zone`. Audit: one `zone.export` row per zone read.

### Changed — PowerDNS sidebar grouped into sub-sections

The PowerDNS nav section is now chunked into **Backends** (Servers,
Clusters, Autoprimaries), **Zones** (Zone templates, Import / Export),
**Security** (TSIG keys), and **Activity** (Request log) so the growing
list stays scannable.

### Changed — admin URL restructure + `oidc.*` → `auth.*` rename (#74)

`/admin/oidc-providers` → `/admin/authentication/oidc`. Same shape for
SAML and LDAP. Old URLs keep redirect stubs so external links survive.
The CASL "Oidc" subject type became "Auth" and the `oidc.read` /
`oidc.manage` permission strings became `auth.read` / `auth.manage`
since the gates now cover three protocols at the unified surface.
Existing role permission lists are auto-rewritten by the migration.

### Changed — profile tabs actually switch panels (#78)

`/profile` tabs were rendering every panel and just scrolling. Tab
identification swapped from a fragile component-function equality
check to a `data-section-tab` marker attribute; visibility uses inline
`style.display` instead of the `hidden` attribute (highest cascade
specificity, no CSS-conflict surface). The component moved to
`components/ui/section-tabs.tsx` and is reused by the new tabbed admin
user-edit page.

### Changed — audit-vocabulary consolidation

Three IdP-prefixed actions unified into protocol-neutral ones:

| Old                                       | New                                |
| ----------------------------------------- | ---------------------------------- |
| `auth.oidc.group_sync.assignment_added`   | _removed_                          |
| `auth.oidc.group_sync.assignment_removed` | _removed_                          |
| `auth.oidc.group_sync.mapping_unresolved` | `auth.group_sync.mapping_unresolved` |
| `auth.{oidc,saml}.linked`                 | `auth.idp.linked`                  |
| `auth.{oidc,saml,ldap}.rejected_provisioning` | `auth.idp.rejected_provisioning` |

Protocol context is preserved via `method` + `provider` fields in the
audit row's `after` snapshot.

### Fixed — SSE badge no longer stuck on OFFLINE for permissionless users (#80)

`/api/realtime` previously hard-403'd a user who couldn't read any
zone. Their EventSource never opened; the chip reported "OFFLINE"
forever. The stream is now opened unconditionally for any
authenticated user — the per-event filters already gate what reaches
them, so the connection is honest about its state.

### Fixed — zones-list scroll-in-scroll at high page sizes (#80)

`<main>` was `flex-1 overflow-y-auto` without `min-h-0`. Under flexbox,
a flex-1 child without `min-h-0` can grow past its parent's height
when its content is taller, defeating `overflow-y-auto` and leaking a
second outer scroll region. One-class fix.

### Added — DataTable pagination at top AND bottom (#80)

Long lists no longer force operators to scroll all the way down just
to flip a page or change the page size. Same controls render at the
top and the bottom of every paginated table.

### Added — SAML 2.0 single sign-on

- **`saml_providers` table** stores SAML SP configurations (ADR-0021). One
  row per IdP relationship: AD FS, Authentik SAML, Keycloak SAML, etc.
  Encrypted SP signing key + optional encryption key + the IdP's public
  signing cert.
- **Admin UI**: `/admin/authentication/new` now offers SAML as an active
  card. Provider edit page at `/admin/saml-providers/<id>` mirrors the
  OIDC equivalent — same pickers, same audit panel, same danger zone.
- **Sign-in routes**:
  - `GET /api/auth/saml/<slug>/login` — signed AuthnRequest + redirect to IdP.
  - `POST /api/auth/saml/<slug>/acs` — Assertion Consumer Service; verifies
    signature, decrypts EncryptedAssertion if configured, applies group →
    role mappings, mints session.
  - `GET /api/auth/saml/<slug>/metadata` — SP metadata XML (paste into IdP).
  - `GET /api/auth/saml/<slug>/slo` — SP-initiated single logout.
- **Secure defaults**: `wantAssertionsSigned: true`, `wantAuthnResponseSigned:
true`, `signatureAlgorithm: "sha256"`, `validateInResponseTo: always`.
  Operators can relax per-provider via the form.
- **Group → role mapping** reuses the OIDC materialiser — same shape, same
  `provider_id`-tagged `role_assignments` rows.
- **Provisioning**: new `saml:` block in `provisioning.yaml`. See
  `provisioning.example.yaml` for a worked example. Slug is reserved in
  `auth_provider_slugs(provider_type='saml')` atomically with the row insert.
- **Login dispatcher**: `auth_default_provider = "saml:<slug>"` now auto-
  redirects to the SAML initiate URL on a fresh visit.
- Library: `@node-saml/node-saml@^5.1.0` (MIT, CVE-2025-54369 fixed).
- Docs: new [`docs/13-SAML.md`](./docs/13-SAML.md) with worked AD FS,
  Authentik, and Keycloak setup. ADR-0021 captures the architecture.

### Added — LDAP authentication (ADR-0020)

- Direct-bind sign-in against **Active Directory** and **OpenLDAP**. Operators
  configure providers under **Admin → Authentication** (the LDAP card on the
  "Add provider" picker is now live alongside OIDC and SAML).
- Bind-then-search-then-rebind flow via the maintained TypeScript-first
  [`ldapts`](https://www.npmjs.com/package/ldapts) library. Strict TLS by
  default — plain `ldap://` is refused unless either StartTLS is enabled on
  the provider row OR `LDAP_ALLOW_INSECURE_PORT_389=true` is set. A new
  `LDAP_TLS_INSECURE_SKIP_VERIFY=true` env knob exists for lab use only;
  production deploys should pin the internal CA on the provider row instead.
- Group → role mappings (global / team / zone / server scope) feed the
  shared `applyGroupSync` materialiser. AD's `memberOf` is read first; an
  optional second search (`group_search_base` + `group_search_filter` with a
  `{{userDn}}` placeholder) handles OpenLDAP installs without the `memberof`
  overlay.
- New `POST /api/auth/ldap/<slug>/login` route — same captcha + per-IP
  rate-limit pipeline as the local + OIDC paths.
- New `ldap_providers` table (PG + SQLite); migrations
  `drizzle/0008_ldap_providers.sql` and
  `drizzle-sqlite/0008_ldap_providers.sql`.
- Provisioning gains an `ldap:` block (worked AD + OpenLDAP examples in
  `provisioning.example.yaml`). A bare-slug `auth_default_provider` resolves
  to an LDAP provider through the existing `auth_provider_slugs` table.
- New audit actions: `ldap.provider.created` / `.updated` / `.deleted` and
  `auth.ldap.rejected_provisioning`. `auth.login.success` after-state now
  carries `method: "ldap"` and `provider: "<slug>"` for sign-ins through
  this path.
- Operator guide: [`docs/12-LDAP.md`](./docs/12-LDAP.md) (worked AD example
  with KB4520412 channel-binding note, OpenLDAP 2.6 example with
  `olcTLSCipherSuite` + memberof-overlay setup).

### Changed — admin sidebar restructure + URL alignment

- **Sidebar "Infrastructure" section renamed to "PowerDNS"**, with shorter
  nav labels now that the section name carries the protocol context:
  - "PowerDNS servers" → "Servers"
  - "Groups" → "Clusters" (the underlying concept is a cluster of peers
    or a primary with its secondaries; "Groups" was a UI carry-over).
  - "Request log" moves up from the "System" section into "PowerDNS" —
    it's PDNS HTTP traffic, not platform audit.
- **URL alignment**: two admin paths renamed to match the rest of the
  section (no `pdns-` prefix; the section already says PowerDNS):
  - `/admin/pdns-clusters` → `/admin/clusters`
  - `/admin/pdns-requests` → `/admin/requests`
  - The old paths redirect to the new ones so bookmarks and audit-log
    links keep working.
- "System" now contains only Settings + Audit log.

### Added — globally-unique provider slugs

- New `auth_provider_slugs` table acts as a cross-type reservation: every
  provider create transaction reserves its slug here first, and the table's
  PK enforces uniqueness across **every** authentication provider type
  (OIDC today; SAML + LDAP when PRs 2 + 3 of `feat/auth-providers-...`
  land). A SAML provider can't claim the same slug as an existing OIDC
  provider. Existing OIDC rows are backfilled by the migration in both
  dialects.
- **Provisioning shorthand**: `auth_default_provider` in the YAML now
  accepts a bare provider slug (e.g. `auth_default_provider: "company-sso"`)
  alongside the existing `local` / `<type>:<slug>` forms. The applier
  resolves a bare slug against `auth_provider_slugs` (including providers
  declared in the SAME file) and persists the canonical typed-prefix form.
  Unknown slugs log a warning and leave the previous value intact.

### Changed — unified authentication admin

- **New `Admin → Authentication` page** consolidates the view of every
  sign-in method into one list. Local Auth appears as a synthetic row
  alongside every configured OIDC provider (and, when PR 2 + PR 3 of
  `feat/auth-providers-ldap-saml-webauthn` land, SAML and LDAP). The old
  `/admin/oidc-providers` index redirects here; per-provider edit pages
  (`/admin/oidc-providers/<id>`, `/admin/oidc-providers/new`) keep their
  URLs. Sidebar nav renames from "OIDC providers" to "Authentication".
- **Default sign-in method is now a single global setting** edited from
  the new page via a themed dropdown — replaces the per-OIDC-provider
  `force_default` checkbox. Stored as `settings.auth_default_provider`
  in the `local` / `oidc:<slug>` / `saml:<slug>` / `ldap:<slug>` format.
  Existing deployments are migrated automatically by the Drizzle migration
  in both dialects (most recently created enabled `force_default=true`
  wins). The `force_default` column is dropped.
- **Provisioning compat**: `force_default: true` in YAML still parses; the
  applier translates it into `auth_default_provider` and logs a
  deprecation warning. Will be removed in a future minor.

### Changed — bounded retention on dashboard time-series tables (1:1 with display windows)

- **The two time-series tables the zone-poller writes now prune to exactly
  the windows the dashboard reads.** `lib/metrics/dashboard-windows.ts` is
  the single source of truth — the dashboard graphs and the retention sweep
  both read from there, so changing a window in one place updates both.
  We keep nothing we don't display.
  - `metric_samples` — 7 days (`backendSeries()` + `sessionsSeries()`).
  - `pdns_server_stats` — 2 hours (per-backend metric widget).
- `readRecentMetrics()` is now time-bounded (takes a `since: Date`) instead
  of the previous count-bounded shape — the count was an implicit 2h window
  at the 60s sampling cadence, and turning it explicit lets retention link
  to the same window cleanly.
- Throttled to one pair of DELETEs per 5 minutes so the sampler's 60-second
  cadence doesn't churn the WAL. Best-effort: a failed prune logs and the
  write path continues. See `lib/metrics/retention.ts`.
- Before this, both tables grew without bound. The dashboard's queries
  scanned ever-larger result sets even though every row past the window
  was discarded. On stacks with long uptime + many backends, this was the
  largest contributor to the SQLite/Postgres data volume.

### Added — auth providers (Phase 1 of `feat/auth-providers-ldap-saml-webauthn`)

- **WebAuthn / passkeys** — sign in with Touch ID, Windows Hello, Android
  screen-lock, hardware security keys (YubiKey etc.) or cross-device
  passkeys (1Password, Bitwarden, iCloud Keychain). Two flows:
  - **Primary credential** — "Sign in with passkey" button on `/login`
    skips the password entirely (discoverable-credential flow).
  - **Second factor** — alongside TOTP. The MFA-required gate (per-role
    `requires_mfa`, per-user override) is now satisfied by EITHER a
    TOTP enrollment OR any WebAuthn credential.
  - Per-credential enrolment + remove + rename under
    `Profile → Two-factor → Passkeys & security keys`.
  - Selective admin reset by credential id (target-privilege ceiling
    enforced like the TOTP reset).
  - RP ID derived from `APP_URL` hostname; override via `WEBAUTHN_RP_ID`
    for apex/sub-domain credential sharing.
  - Strict-by-default origins; LAN-dev opt-out via
    `WEBAUTHN_ALLOW_INSECURE_ORIGINS=true`.
  - New docs page: [`docs/11-PASSKEYS.md`](./docs/11-PASSKEYS.md).
- **OIDC logout hardening** — fixes the "sign out lands me back signed in"
  bug operators hit with IdPs that don't advertise `end_session_endpoint`:
  - `/api/auth/logout` sets a 60-second `pda_just_logged_out` cookie that
    suppresses `force_default` OIDC auto-redirect on the next `/login`
    render, so the IdP's still-valid session can't silently re-auth.
  - The OIDC discovery probe now reports whether the IdP advertised an
    end-session endpoint; the admin OIDC providers list shows a yellow
    "no end-session" warning chip when it's missing, with IdP-specific
    fix guidance in `docs/05-OIDC.md`.
- **Architecture decision records** for the road map:
  - ADR-0018: provider abstraction — keep OIDC where it is, layer SAML +
    LDAP as siblings.
  - ADR-0019: WebAuthn — both primary credential and second factor.
  - ADR-0020 (proposed): LDAP architecture — TLS-strict default,
    `ldapts@^8`, bind-then-search, AD + OpenLDAP doc examples
    (lands in PR 2 of the feature branch).
  - ADR-0021 (proposed): SAML 2.0 SP — signed assertions required by
    default, `@node-saml/node-saml@^5.1.0` (CVE-2025-54369 fixed),
    AD FS / Authentik / Keycloak doc examples (lands in PR 3).

### Added

- **Login: inline APP_URL mismatch banner.** Detects when the request host
  doesn't match `env.APP_URL` (the classic "copy-pasted `http://localhost:3000`
  but I'm browsing the LAN host" foot-gun) and surfaces it on the sign-in page
  with the actual + expected origin, so operators don't have to crack open
  DevTools to find out why their session cookie was silently rejected. Helper
  is unit-tested (`lib/auth/app-url-check.ts`).
- **Compliance guard now covers MFA enforcement, not just must-change-password.**
  The shake-banner-on-blocked-nav behaviour is reused for forced TOTP enrolment;
  `requireUserForPage` re-checks both gates on every soft navigation
  (mirrors what was already there for password change).
- **Roles list: description column** + the description renders on both system
  and custom-role detail pages. Wraps cleanly, never truncates.
- **METRICS_TOKEN auto-generation.** When `/metrics` is enabled but no token is
  pinned in env, the app generates a random 32-char bearer on boot and logs it
  once — keeps the endpoint from being accidentally open on a shared LAN.

### Changed

- **Force-MFA + OIDC users.** SSO-only accounts (no local password) are now
  always exempt from MFA enforcement: the IdP is the second-factor authority
  and the in-app TOTP enroll flow is read-only for them. The admin user-detail
  page hides the per-user MFA override for SSO accounts, and the PATCH
  endpoint rejects setting `mfaRequired=true` on them. `checkMfaCompliance`
  defends against legacy rows that already carried that flag.
- **Installation docs** split into two paths (Docker / from-source) with a
  systemd unit + tested nginx and HAProxy reverse-proxy examples that get the
  `X-Forwarded-*` headers right for the APP_URL mismatch detector.
- **APP_URL guidance** elevated to its own install step + `.env.example`
  comment, with the cookie-domain reasoning spelled out (operators copy-pasting
  `http://localhost:3000` from the example hit a silent cookie rejection).

### Fixed

- **Login page "preload was not used" warnings.** The wordmark rendered both
  light + dark PNGs with Next.js `priority`, emitting two `<link rel="preload">`
  tags while CSS hid one — browsers warned every page load. Dropped `priority`;
  the visible image still loads eagerly above the fold.

## [1.2.1] — 2026-05-27

A **build-pipeline patch** — significant image-size reduction with
no operator-facing behaviour change. The published image goes from
**~1.18 GB local / ~225 MB compressed pull** to **~290 MB local /
~80 MB compressed pull** (about a 75% local / 65% compressed cut).
Drop-in upgrade — no schema, API, or operator-config changes.

### Changed — build pipeline

- **Boot scripts pre-bundled at image-build time.** `scripts/migrate.ts`,
  `scripts/seed.ts`, and `scripts/provision.ts` are now built into
  self-contained ESM files under `boot/` via `npm run build:boot`
  (esbuild). The runner runs them directly with `node`, so the runtime
  image no longer needs:
  - `tsx` (the on-the-fly TS transpiler the previous entrypoint shelled
    out to),
  - the full `lib/` and `scripts/` source trees,
  - `tsconfig.json`, or
  - the separate prod-deps `node_modules` overlay (the previous `deps`
    stage — ~700 MB on disk used solely to make boot succeed).
- **Dockerfile: `deps` stage removed; runner switched to distroless.**
  The build now goes builder → fs-prep → runner, where the final
  runner is `gcr.io/distroless/nodejs24-debian12:nonroot`. Boot
  externals (`better-sqlite3`, `@node-rs/argon2`, `pg`, `pino` +
  transports) resolve at runtime from the standalone bundle's
  already-traced `node_modules` — Next's image-tracer has been
  ensuring those are present all along; the dedicated `deps` overlay
  was redundant.
- **Next.js trace exclusion for `@img/sharp*`** combined with
  `images: { unoptimized: true }` in `next.config.ts`. Sharp was a
  ~16 MB optionalDep used only by Next's built-in image optimizer;
  with the optimizer off (the wordmark PNGs in `/public` are tiny
  pre-sized assets, and brand-logo uploads render via a plain `<img>`)
  it never runs and can be left out of the runner entirely.
- **Native-binary debug symbols stripped** during the build. Sub-MB
  but free; the binaries `dlopen` identically.

### Operator-facing trade-offs

- **No shell in the runtime image.** `docker exec <container> sh` is
  not available anymore — the distroless base ships only the `node`
  binary, glibc, openssl, and ca-certificates. For incident triage
  that needs a shell, build a `:debug` tag against bookworm-slim using
  the same builder stage. Day-to-day operations (logs, healthz/readyz
  probes, env reload, image upgrades) are unaffected.
- **Container user is now `nonroot` (uid 65532)** instead of `node`
  (uid 1000). If you'd hand-set ownership on a host-mounted `/data`
  volume to uid 1000 prior, re-chown it to 65532 before the first
  upgraded boot. The compose files in this repo's docker-compose-\*.yml
  examples don't pin a uid and need no change.
- **Next.js built-in image optimizer is disabled.** `<Image>` tags
  still render — they just serve the file at its intrinsic size, no
  resize or format conversion at the edge. No PowerDNS-AuthAdmin page
  relied on the optimizer (our images are static brand assets); this
  is only a difference for downstream customisation that adds dynamic
  image processing via `next/image`.

### Changed — image tags

`:latest` now follows releases, not `main`.

| Tag              | Points to                               |
| ---------------- | --------------------------------------- |
| `:latest`        | most recent release (`vX.Y.Z` tag push) |
| `:X.Y.Z`, `:X.Y` | that release + its minor channel        |
| `:edge`          | tip of `main` (every push)              |
| `:sha-xxxxxxx`   | exact commit, immutable                 |

Operators following `:latest` will jump to `1.2.1` on next pull and
then stay there until the next release tag. Use `:edge` to track
`main`.

### Unchanged

- Same Next.js standalone server, same migration SQL files, same
  entrypoint flow (migrate → seed → provision → server).
- `/healthz` + `/readyz` semantics unchanged.
- All API, auth, RBAC, OIDC, signup, audit, and PDNS-backend behaviour
  identical.
- Cosign signing + SBOM attachment unchanged.

### Upgrading

Pull the new image and recreate the container — that's the whole
upgrade. See [Upgrading → 1.2.1](./docs/09-UPGRADING.md#upgrading-to-121-from-12x)
for the no-shell / non-root caveats.

## [1.2.0] — 2026-05-26

A **minor release** that combines two closely-related changes:

1. **Standalone-PDNS write-capability fix (#57).** A daemon with the
   default `primary=no, secondary=no` in `pdns.conf` was incorrectly
   hidden from `/zones/new`'s backend picker.
2. **`PDNS_BACKGROUND_POLLING` opt-in flag.** AuthAdmin no longer
   maintains a background ticker against PDNS unless the operator
   explicitly opts in. The supplementary "replication-awareness"
   surfaces (sync chip, zone Sync + Statistics tabs, servers Sync
   column, dashboard PDNS metrics, drift advisories) are gated on
   this flag.

> **NOTE — behaviour change on upgrade.** `PDNS_BACKGROUND_POLLING`
> defaults to `false`. Existing 1.1.x deployments that rely on the
> sync chip, dashboard PDNS metrics, per-zone Sync tab, or drift
> advisories **MUST NOW ENABLE** `PDNS_BACKGROUND_POLLING=true` in
> their environment and restart the app to keep those features. See
> [Upgrading → 1.2.0](./docs/09-UPGRADING.md#upgrading-to-120-from-11x)
> for the use-case guidance.

Closes #57; reported by @insxa in
[discussion #27](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/discussions/27).

### Added

- **`PDNS_BACKGROUND_POLLING` env var (default `false`).** Single
  opt-in switch for the replication-awareness layer. When off, every
  PDNS interaction is a direct consequence of an operator action — no
  background traffic. When on, the unified poller runs on its 30 s /
  60 s / 5 min cadences and powers the SYNCED/DESYNCED chip, per-zone
  Sync + Statistics tabs, servers-list Sync column, zones-list mirror
  column, dashboard PowerDNS-metrics tab, and the drift-derived
  advisories in the bell. (#57)
- **`(i)` polling-mode hint** on every polling-gated page heading
  (`/dashboard`, `/admin/servers`, `/zones`, `/zones/<id>`) when polling
  is off — hover tooltip explains the current state and links to the live
  CONFIGURATION doc. One small icon, consistent across the app, so an
  operator can flip the flag deliberately from wherever they are when
  they notice a sync-aware feature is missing.
- **`flash=polling-required` error toast** when an operator follows a
  direct URL to a gated feature (`/dashboard?tab=pdns`,
  `/zones/<id>?tab=sync`, `/zones/<id>?tab=statistics`) on a polling-off
  install — the page redirects to the default view and surfaces a red
  error toast naming the env var.
- **Boot-time log line** at the first `/healthz` hit summarising the
  effective polling mode plus a sharp warning when the configured fleet
  has replication topology but the flag is off (mirrors / multiple
  primaries / clusters). Hard 3 s budget — never blocks startup.

### Changed

- **`isWriteCapable` is now `caps ? !isReadOnlyMirror(caps) : true`.**
  The predicate flipped from gating on the AXFR-primary flag to gating
  on the explicit observation of a read-only mirror — so standalone
  (`primary=no, secondary=no`), explicit primary, and dual-role
  primary+secondary all correctly count as writable. Only a pure
  secondary mirror is excluded from `/zones/new`'s picker. (#57)
- **Header sync chip gates on actual replication topology AND the
  poller flag.** `hasReplicationTopology()` was added in this cycle;
  the chip only enters SYNCED/DESYNCED mode when both a ≥2-peer cluster
  (derived primary+secondaries OR configured multi-primary) AND
  `PDNS_BACKGROUND_POLLING=true` are present. Standalone /
  single-primary / polling-off fleets see plain "Live". (#57)
- **Capability badge `none` → `standalone`.** The neutral badge for a
  daemon with no replication flags now reads `standalone`, matching the
  semantic ("hosts zones over the API; no DNS-protocol replication")
  and removing the alarming "none" label. Same neutral tone.
  `summarizeCapabilities()`'s fallback follows suit (`api` →
  `standalone`); `api: no` → `unreachable`.
- **Dashboard tab strip hides** when polling is off — the "Admin" view
  becomes the default (and only) tab. The PDNS-metrics tab body
  redirects with the flash toast on direct URL.
- **Zone-detail Sync + Statistics tabs hide** when polling is off.
  Direct ?tab=sync / ?tab=statistics URLs redirect to the records tab
  with the flash toast.
- **Servers-list Sync column hides** when polling is off (the page's
  realtime sync subscriber stays unmounted; row reachability still
  updates on every operator-initiated probe).
- **Zones-list mirror column hides** when polling is off; default sort
  collapses to Name asc instead of Sync-desc then Name.

### Fixed

- Standalone-PDNS daemons no longer rendered as `none` /
  not-a-write-target on `/admin/servers` or hidden from `/zones/new`. (#57)
- `scheduleImmediatePoll` and the in-flight `scheduleFollowupPoll` are
  no-ops when polling is off; mutations still publish their own SSE
  refresh and call `invalidateBackendObservation`, so the next page
  render warms what it needs via `ensureBackendsObserved`.

### Tests

- Four-way table test for `isWriteCapable` × `isReadOnlyMirror` across
  the standalone / primary / secondary / dual-role flag matrix.
- `unprobed (null)` defaults to write-capable so a freshly-added
  backend stays usable until its first probe.
- Polling-flag tests pin `ensurePollerRunning` to no `setInterval`,
  and `scheduleImmediatePoll` to no `setTimeout`, when the flag is off.
- **`decideHeaderChipMode` pure helper** (extracted from `app/(app)/layout.tsx`)
  is unit-tested across all five gating inputs (polling enabled, realtime
  available, can-read-backends, has-topology, lagging) — every false
  gate falls back to plain "Live"; only the full happy path enters sync
  mode.
- **`describeFlash` for `polling-required`** is unit-tested to produce a
  red error toast naming the env var verbatim (so operators can grep for
  it), with and without the `need=` parameter.
- **`logPollingModeOnce` startup log** is unit-tested across three
  branches (flag on info; flag off + standalone info; flag off + topology
  warn) plus the 3 s probe budget timing out gracefully and the one-shot
  guard against re-firing.
- Integration suite pinned to `PDNS_BACKGROUND_POLLING=true` so the
  replication-aware code paths stay exercised end-to-end.

## [1.1.5] — 2026-05-26

A **security-hygiene patch**. No app-code changes; ships only a defensive
dependency pin to neutralise the **Mini Shai-Hulud** npm supply-chain
campaign (MAL-2026-4153) at the resolver level. See
[GHSA-…-…-…](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/security/advisories)
for the full advisory.

### Security

- **Defensive pin: `size-sensor` → `1.0.3` via package.json `overrides`.**
  The npm package `size-sensor` (an indirect dependency through
  `echarts-for-react`) was hijacked on 2026-05-19 — versions `1.0.4`,
  `1.1.4`, and `1.2.4` were published by an attacker who took over the
  `atool` npm account and contain a `preinstall` hook that runs an
  obfuscated Bun script exfiltrating secrets to GitHub via
  `harkonnen-melange-*` repositories (Mini Shai-Hulud / TeamPCP).
  Tracked as
  [MAL-2026-4153](https://osv.dev/vulnerability/MAL-2026-4153) /
  [GHSA-gx6x-v325-85g4](https://github.com/advisories/GHSA-gx6x-v325-85g4).

  **PowerDNS-AuthAdmin was never affected** — every `1.1.x` release
  shipped `size-sensor@1.0.3`, the last clean version (published before
  the takeover). `npm audit` was clean throughout. This release adds an
  explicit `"size-sensor": "1.0.3"` to `package.json` `overrides` so that
  no future `npm install --save <…>` can let the resolver pick up
  `1.0.4`+ from a freshly-resolved subtree. OpenSSF Scorecard's
  `Vulnerabilities` check, which flags any version inside the OSV
  advisory's overly-broad SEMVER range, should clear on its next
  refresh.

## [1.1.4] — 2026-05-26

A **major operator-UX release**: top-to-bottom responsive overhaul, every table
unified onto one mobile-friendly recipe, live fleet-wide sync state in the header
chrome, a new animated sync indicator, full screenshots gallery regen, plus the
security and supply-chain hardening previously parked in `[Unreleased]`. No
schema or API breaking changes — drop-in upgrade.

### Added — operator UX

- **Mobile-first responsive shell.** Off-canvas hamburger drawer under `md`,
  full sidebar from `md+`. The drawer closes on backdrop tap, Esc, and route
  changes (no in-drawer close button needed). The top bar reflows so every
  control (hamburger, status chip, bell, theme, avatar) is reachable on a
  320 px viewport. (#51, #52)
- **Live header status chip with fleet-wide sync verdict.** Single pill in the
  top bar shows `CONNECTING / CONNECTED / OFFLINE / PAUSED` (SSE connection
  state) plus a trailing `· SYNCED / · DESYNCED` whenever the page has a
  notion of sync state. The off-the-shelf default is the fleet-wide
  `globalAnyLagging()` verdict computed from the in-process zone-state cache
  (no extra PDNS hit). Per-page `<HeaderStatusMode/>` overrides on zone
  detail, the zones list, and the servers page. A 5 s grace prevents
  "OFFLINE" flashes on Ctrl-R. (#52)
- **Animated SyncIndicator.** New concentric-ring SVG used everywhere a sync
  verdict is displayed (header chip, zones list per-row chip, servers table).
  **Synced** = solid centre + two outward-pulsing rings via staggered CSS
  keyframes (radar/sonar ping). **Desynced** = hollow centre + two dashed
  concentric rings that counter-rotate via `stroke-dashoffset` so the icon
  reads as _actively trying to sync_, not a frozen error. Honours
  `prefers-reduced-motion`. (#52)
- **One DataTable everywhere.** The audit log, profile sessions, autoprimaries,
  OIDC providers, TSIG keys (read-only + manage), dashboard backends + recent
  activity, role-assignments panel, team-members panel, zone change-history,
  and the zone-templates / servers / users / roles / teams lists now all use
  the same `<DataTable>` recipe — `bg-bg-muted` thead, `even:bg-bg-subtle`
  body stripes, accent-tinted hover wash, mobile auto-reflow to labelled
  cards. No more bespoke `<table>` markup outside dialog-internal review
  panels. (#52)
- **Diff-before-apply for record edits.** The per-RRset editor now insists on
  a **Review changes** modal between Save and the PATCH; the diff is
  BIND-style before/after, validation errors are gated behind an explicit
  _Save anyway_ checkbox so overrides are intentional and audited verbatim.
  (#52)
- **One-button theme toggle.** Was three buttons (sun / monitor / moon). Now
  one button whose icon mirrors the active preference and cycles
  `light → dark → system → light` on click. Pre-hydration `.dark` class
  unchanged — no flash of wrong theme. (#52)
- **Capability badges + clickable rows.** Per-backend badges (`CLUSTER`,
  `DEFAULT`, `PRIMARY`, `READ-ONLY MIRROR`) standardised across every list.
  Rows + mobile cards are now click-to-detail; embedded links/buttons (Edit,
  Delete, Test) intercept so per-row actions still work. (#52)
- **Compliance hard-stops on every navigation.** Operators with
  `must_change_password = true` or unmet MFA-per-role requirements are pinned
  to `/profile` (or an allow-list of self-service routes) on every page nav,
  not just the initial render. The header status chip is suppressed in that
  state because the SSE endpoint would 403 anyway. (#52)
- **Mobile zone-tabs no longer truncate, change history reflows.** Tabs
  `flex-wrap` on `< sm` so "Change history" (the widest label) never falls
  off-screen. New `<ScrollToTab/>` auto-scrolls to the tab strip when
  `?tab=` is set in the URL. Zone change-log gets a mobile-card layout
  alongside the desktop table — same expand-on-click pattern, but no clipped
  Resource/Actor columns on a 360 px viewport. (#52)
- **CTAs no longer wrap their labels.** `whitespace-nowrap` on the shared
  green "+ Add" button class — fixes the "+ Add role" rendering as
  "+ Add" / "role" on narrow flex rows. (#52)
- **PDNS request log documented.** The per-call HTTP audit surface at
  `/admin/pdns-requests` was undocumented despite shipping since 1.1.0.
  Filters by server / op / status / `requestId` / time range; every row
  expands inline to the request + response detail; cross-pivots to / from
  the audit log via shared `requestId`. ([FEATURES § 3.6](./docs/FEATURES.md#36-pdns-request-log))
- **Backend health bell documented.** The alert bell + popover that surfaces
  active advisories (unreachable hosts, API-key rejections, replication
  drift, missing TSIG keys, mirror zones without `masters`, daemon-config
  drift between peers) is now an explicit feature in the catalog.
  ([FEATURES § 3.7](./docs/FEATURES.md#37-backend-health-advisories) · [ADR-0015](./docs/adr/0015-backend-health-advisories.md))

### Added — documentation

- **Visual gallery regen.** Every page is captured at four parities —
  desktop+light, desktop+dark, mobile+light, mobile+dark — and rendered with
  `<picture>` so they auto-switch to match the reader's theme. Mobile shots
  are wrapped in a CSS-rendered iPhone 16 Pro bezel (status bar with Dynamic
  Island sits above the page; Action Button left, Camera Control right).
  See [`screenshots/`](./screenshots/README.md). (#53)
- **`scripts/screenshots.mjs`.** Playwright-driven regen tool. Per-page
  `prepare(page)` hooks for surfaces that need a click or two (zone-edit,
  zone-edit-diff, zone-change-history, backend-health). Comma-separated
  CLI page filter or `PAGES_FILTER` env. Optional `pngquant + oxipng`
  post-pass shrinks the gallery by ~70 % when both binaries are on PATH.
  Documented in [`docs/dev-setup.md`](./docs/dev-setup.md#regenerating-screenshots).
  (#53)
- **`docs/FEATURES.md` § 19 — Operator UX & responsive design.** Eight
  sub-sections covering everything new in this release with module pointers.
  Cross-linked from the screenshots gallery. (#53)
- **Root README mobile-first showcase.** Three iPhone-framed mobile shots
  (dashboard, zone detail, audit log) below the desktop grid + a link to the
  full gallery. (#53)
- **Inline screenshot embeds** at every feature section in `docs/FEATURES.md`
  and hero shots in `docs/01-QUICKSTART.md`, `docs/04-BACKENDS.md`,
  `docs/05-OIDC.md`, `docs/07-RBAC.md`. (#53)

### Security

- **Patched dev/build dependency CVEs** via `overrides` — the deprecated `@esbuild-kit`
  chain is forced onto `esbuild@0.25.12` (dev-server CORS) and `next`'s pinned `postcss`
  up to `8.5.15` (`</style>` XSS). `npm audit` is clean. (OpenSSF Scorecard: Vulnerabilities.)
  (#47)

### Added — supply-chain

- **Property-based fuzz tests** (`fast-check`) for the DNS parsers — TXT presentation,
  DynDNS request/auth, and every RR-type content validator — running in the unit suite as
  `*.fuzz.test.ts`. Hardens the hand-rolled parsers (which have shipped real bugs) and
  satisfies the OpenSSF Scorecard Fuzzing check. (#48)
- **Signed releases + image provenance.** A `release-sign` workflow (on release publish)
  cosign-signs the published multi-arch image (keyless / Sigstore) and attaches an SPDX SBOM
  plus a signed checksums bundle (`*.sigstore.json`) to the GitHub release. Verify the image
  with `cosign verify ghcr.io/powerdns-authadmin/powerdns-authadmin:1.1.4` (see
  [Hardening → verifying the image](./docs/08-HARDENING.md)). (OpenSSF Scorecard: Signed-Releases.)
  (#49)

### Fixed

- **Stale CODEOWNERS path** (`middleware.ts` → `proxy.ts`). (#50)

## [1.1.3] — 2026-05-26

### Fixed

- **Per-zone grants now work on multi-primary clusters.** A `zone_grant` is keyed to one
  backend, but a cluster zone's reads/writes resolve a rotating peer (`choosePeer`), so a grant
  issued on one peer intermittently returned 403 when another peer was chosen. Grants are now
  expanded across cluster peers on the authorization path, so a grant on any peer authorizes the
  zone on every peer of that cluster. (#40)

### Changed

- **`middleware.ts` → `proxy.ts`.** Adopted the Next 16 `proxy` file convention (the `middleware`
  convention is deprecated); the per-request CSP nonce + security headers are unchanged. (#41)
- **CI GitHub Actions re-pinned to Node 24-compatible releases** (still pinned by commit SHA),
  ahead of GitHub's deprecation of the Node 20 action runtime. (#44)

### Documentation

- **Installation guide rewritten** to four bulletproof, copy-paste steps (pick a database → create
  `.env` → write `docker-compose.yml` → start), plus a docs-wide accuracy sweep (bootstrap-admin
  semantics, lockout default, metrics route/default, provisioning order, dev-setup flow) verified
  against the code.
- **`act` documented as the pre-push local-CI standard** (a committed `.actrc` pins the runner
  image); it runs the JS-action jobs locally, while CodeQL / Docker / Scorecard remain on GitHub CI.
- README: added a GHCR pulls badge and a "PowerDNS Auth tested versions" header over the
  compatibility badges.

## [1.1.2] — 2026-05-25

### Security

Findings from an internal security audit. Distinct advisories are tracked privately
as GHSA records; the fixes are summarized here.

- **MFA-enrollment and forced-password-change gates now enforced on API routes, not
  just page loads.** `requireUser` (the shared route guard) now refuses a **session**
  whose role requires MFA but hasn't enrolled, or that is flagged
  `mustChangePassword`, with the self-remediation endpoints (TOTP enrollment, change
  password, logout) explicitly exempt. Previously these gates lived only in the page
  layout, so a non-compliant user — or anyone holding their session — could call the
  JSON write APIs directly and bypass them.
- **Privilege-escalation ceilings closed on three admin paths.** Creating a user
  with an initial role now applies the same "can't grant permissions you don't hold
  globally" ceiling the role-assignment route already enforced (it previously didn't,
  allowing a non-Super-Admin to mint a global Super Admin). Resetting another user's
  password and removing another user's MFA now refuse to target a user who holds
  global permissions the actor lacks (previously a `user.reset-password` holder could
  take over a Super Admin account).
- **OIDC outbound requests are now IP-pinned against DNS rebinding.** Discovery, JWKS,
  and the token-exchange POST (which carries the client secret) now connect only to
  the address the SSRF guard validated — closing the TOCTOU window the PDNS client
  already guarded. The background discovery sampler also runs the SSRF guard before
  probing. The pinning logic is shared via a new `lib/net/pinned-fetch` module.
- **Defense-in-depth hardening:** the audit-log redaction backstop now also catches
  `*Encrypted` / `oidcIdToken` columns; the `serverId` PDNS path segment is
  URL-encoded; client-IP parsing uses strict `isIP`; `APP_ENCRYPTION_KEY` byte-length
  is validated at boot (not at first use); the SSE per-user connection counter no
  longer leaks a slot on pre-start abort; and PDNS error bodies are redacted before
  being surfaced.

### Fixed

- **Self-service-signup email verification is now redeemable.** The verification link
  worked only for an already-signed-in user, but a freshly-signed-up local account is
  blocked from signing in until verified — a deadlock. Verification is now an
  unauthenticated, token-only flow (the signed token proves ownership), and the verify
  page renders for logged-out users.
- **Audit writes made atomic with their mutation** on the PowerDNS-server create/update
  routes (the audit row was written outside the mutation's transaction), and on OIDC
  group-sync role changes.
- **SQLite dashboard "events per hour"** buckets are now computed in UTC, matching the
  Postgres path (they previously skewed by the server's local timezone offset).
- Minor: per-team member counts filter in SQL rather than in memory; a failed audit
  insert after an already-applied zone edit no longer returns a 500.

## [1.1.1] — 2026-05-25

### Security

Coordinated batch resolving six advisories (GHSA-gjg4-58c5-2qg3, GHSA-wf29-rmhc-rqc9,
GHSA-24hf-rxww-95cf, GHSA-phv2-wjmm-pqqq, GHSA-frpq-xgm7-574x, GHSA-86v6-w5p9-29r8).

- **Zone-grant route now enforces the permission ceiling (GHSA-gjg4-58c5-2qg3, high).** The
  per-user zone-grant route assigned a role's permissions without checking them against the
  granting admin's own authority, so an admin could grant — through a zone scope — permissions
  they didn't hold globally (privilege escalation). It now applies the same
  `permissionsExceedingGrant` ceiling as role assignment.
- **OIDC group→role mappings now enforce the permission ceiling (GHSA-wf29-rmhc-rqc9, high).** An
  `oidc.manage` holder could map an IdP group to a role granting permissions they lacked, then
  escalate by signing in through that group. Mappings are rejected at save time unless every
  mapped role is within the actor's global permission ceiling.
- **OIDC `requireEmailVerified` default changed to `true` (GHSA-24hf-rxww-95cf, high).** The
  `createOidcProviderSchema` previously defaulted `requireEmailVerified` to `false`, shipping
  new DB-configured OIDC providers with the account-takeover guard disabled. The default is now
  `true`, matching the documented intent and the env-provider behaviour. **Existing DB rows
  keep their stored value** — operators should audit any provider where `requireEmailVerified`
  is `false` and confirm the IdP does not emit the `email_verified` claim before retaining
  that setting.
- **AES-GCM authentication-tag length enforced on decrypt (GHSA-phv2-wjmm-pqqq, medium).**
  `decrypt()` accepted a truncated GCM auth tag (Node permits tags ≥ 4 bytes by default),
  silently downgrading integrity strength. It now requires the standard 12-byte IV and 16-byte
  tag and passes `authTagLength` as defence-in-depth.
- **Failed-login counter increment made atomic (GHSA-frpq-xgm7-574x, medium).** The lockout
  counter used a read-modify-write, so concurrent failed logins could lose increments and exceed
  the lockout threshold. The increment is now a single atomic
  `failed_login_count = failed_login_count + 1 … RETURNING` statement.
- **Last-Super-Admin guard hardened (GHSA-86v6-w5p9-29r8, medium).** The guard counted raw
  assignment rows (including disabled users and duplicate rows), so the last _usable_ global
  Super Admin could be disabled or deleted — locking the install out of its own administration.
  It now counts distinct **enabled** users and also covers the user disable + delete routes
  (previously only assignment removal was guarded).
- **Content-Security-Policy `script-src` tightened.** Removed `'self'` and the Cloudflare
  Turnstile host from `script-src`; the directive is now the per-request nonce plus
  `strict-dynamic` (with `'unsafe-eval'` only in dev), so an injected inline or remote script can
  no longer execute by virtue of same-origin or a hard-coded allow-listed host.
- **DNS-rebinding hardening on outbound PowerDNS requests.** The reachability guard validated the
  backend host, but the follow-up HTTP request re-resolved DNS — a TOCTOU window a rebinding
  record could exploit to reach a blocked address. The guard-validated IP is now pinned into the
  request dispatcher, so the connection targets the address that actually passed the guard.
- **Supply-chain & scanning hardening.** Every third-party GitHub Action is pinned to a full
  commit SHA, and the container base image to a `sha256` digest; CodeQL runs the
  `security-and-quality` query suite; and CodeQL, dependency-review, and OpenSSF Scorecard now gate
  pushes/PRs. Also resolved three `js/incomplete-sanitization` findings — a literal backslash is
  now escaped before the following metacharacter when building SVCB/HTTPS and SOA-mailbox rdata.

### Added

- **Self-service signup.** Optional `SIGNUP_ENABLED` exposes a `/signup` page and API (both 404
  when off, the default). New accounts receive the low-privilege `SIGNUP_DEFAULT_ROLE` — a
  boot-time guard refuses an admin-equivalent role — with an optional `SIGNUP_ALLOWED_EMAIL_DOMAINS`
  allow-list and SMTP-backed email verification. See [Configuration](./docs/03-CONFIGURATION.md).
- **Inline SVG brand logo.** The settings brand logo now accepts an inline `data:` SVG URI in
  addition to an `https://` URL; inline SVG is sanitized server-side (DOMPurify) before it is
  stored or rendered.
- **Build provenance in the version chip.** Non-release / local builds show the short commit SHA
  in the sidebar version chip, so a running build is unambiguously identifiable.

### Fixed

- **Dashboard active-session count.** The "active sessions" KPI was sampled in a way that always
  reported 0; the sampler now counts live sessions correctly.
- **DNS record validators.** Corrected the SRV port-range bound, accept the all-zeroes IPv6 group
  (`::`) in AAAA, reject an unbalanced quote in CAA, and fix the TXT bare-text escape order
  (RFC 1035 § 5.1).
- **SQLite write path.** Writes and their audit row now commit in a single real transaction
  (atomic), and the `backend_advisories` `first_seen_at` / `last_seen_at` defaults match the
  Postgres schema.
- **Cluster routing.** Probe/failure latencies no longer skew peer selection, and the round-robin
  index is shared across the process so rotation stays even.
- **Redis event-bus handler.** The cross-replica SSE message handler is registered exactly once,
  so an event is no longer delivered multiple times when `REDIS_URL` is configured.
- **SelectMenu drop-up.** The themed select menu flips upward when it would otherwise open past
  the bottom of the viewport.

### Documentation

- **Installation: persist secrets in `.env`.** The setup used shell `export`s for
  `APP_SECRET_KEY` / `APP_ENCRYPTION_KEY`, which silently change on the next shell and guarantee a
  lockout. It now writes them once into a Compose-loaded `.env`, with explicit `down` vs `down -v`
  guidance.

## [1.1.0] — 2026-05-24

### Security

- **OIDC issuer SSRF guard.** The operator-supplied OIDC issuer/discovery URL is fetched
  server-side (provider test + live discovery), so it now runs through the same outbound-URL guard
  as PowerDNS backends. By default in production it refuses an issuer that resolves to a
  private-network address or uses `http://`; link-local / cloud-metadata (`169.254.0.0/16`) is
  always blocked. Two new opt-in flags relax it for an internal IdP:
  `APP_OIDC_ALLOW_PRIVATE_NETWORKS` and `APP_OIDC_ALLOW_INSECURE_HTTP`.
- **Role-assignment permission ceiling.** Granting a role now refuses to assign permissions the
  acting admin doesn't themselves hold globally — you can no longer mint a role assignment that
  exceeds your own authority. A last-Super-Admin guard also blocks removing the final global
  Super-Admin assignment, so an install can't be locked out of its own administration.

### Added

- **Optional Redis for horizontal scale (replicas > 1).** Setting `REDIS_URL` makes auth rate
  limiting, one-time reveal tokens, and the realtime SSE event-bus coordinate across replicas
  (sessions were already shared via Postgres). Each falls back to its in-process path when Redis is
  unset or a command fails, so single-node deployments need no Redis and a Redis blip degrades
  coordination rather than causing an outage. Ships a `docker-compose.ha.yml` example and a README
  High-availability section. See [ADR-0016](./docs/adr/0016-redis-horizontal-scale.md).
- **Return-to-intended-page after sign-in.** Hitting a deep link (e.g. `/zones`) while signed out
  now sends you back to that page after login — including through the OIDC round-trip — instead of
  always dumping you on the dashboard. The redirect target is validated to be a same-origin
  relative path.
- **Add servers while creating a group.** The "new group" form now has a themed, multi-select list
  of ungrouped backends so you can add members at creation time (assigned atomically, audited per
  server); the Groups page is a list view.
- **Hidden-zone warning on the zones list.** When the same zone name is served by a backend that
  isn't shown, a banner above the ALL / FORWARD / REVERSE filter surfaces the count and the distinct
  hidden backends. It fires only for cases an operator should notice — standalone secondaries
  mirroring an unmanaged primary, or the same name on a second primary — and stays silent for a
  primary's secondaries whether they're **grouped or auto-derived** (matched to their managed
  primary by `masters[]`, exactly as the servers page nests them), since that's normal replication.
- **Read-only secondary backends** — secondaries can now be added **without** an app-managed
  primary (unpinned mirrors of an external/upstream primary), and their otherwise-invisible zones
  appear in the amalgamated zone list (deduped: only zones no primary already serves), badged
  "read-only". The zone detail renders records + DNSSEC read-only for a secondary while leaving the
  legitimately-writable replication config (the zone's `masters`, transfer metadata, and removing
  the mirror) editable. A server-side guard backstops this for the API/token surface: zone-content
  writes (records, DNSSEC, zone create/clone) to a secondary are rejected (409).
- **DNSSEC + DNS-resolution integration tests** — DNSSEC is now enabled on the test backends
  (`g*-dnssec=yes`), and the suite verifies, against a live stack, that records resolve over real
  DNS after the app writes them, that securing a zone serves DNSKEY + RRSIG on the primary, and
  that the signed zone transfers presigned to a secondary via AXFR and resolves there.
- **PowerDNS compatibility matrix + badges.** One workflow per supported PowerDNS Authoritative
  version (**4.6 → 5.0**, sharing a reusable core) runs the full end-to-end suite on each
  minor/major release tag (plus monthly and on demand) — not on every push. Each exposes a live
  GitHub Actions status badge in the README (no committed state to maintain).

### Changed

- **Sidebar navigation** regrouped into **Infrastructure / Access / System** sections (was a single
  flat "Admin" list), with clearer section headers and indented children, and the
  previously-orphaned **TSIG keys** and **Autoprimaries** admin pages are now linked.
- The zones list's **DNSSEC** column now shows a green closed padlock when a zone is signed and a
  muted open padlock when it isn't (was "on"/"off" text).
- **Server `/config` view** dropped the `# slug — /config (read-only)` caption header, and the
  daemon `api-key` now shows redacted (`<redacted>`) rather than being omitted entirely — so the
  operator can see the setting is present without exposing the secret.
- **Unified the collapsible "summary" disclosure** used by the audit log and the PowerDNS HTTP
  request logs into one shared component, and fixed the cramped top spacing in the expanded request
  view.
- **Migrations squashed** to a single migration per dialect for 1.1.0 (capabilities +
  advertised-addresses columns, the dropped per-server role enum + `primary_id`, and the
  `backend_advisories` table). See [ADR-0017](./docs/adr/0017-migration-squash-1.1.0.md).
- **CI split for speed.** Every push/PR now runs the integration suite against one pinned PowerDNS
  image; the full 4.6 → 5.0 matrix moved to the release-time compatibility workflow above. The
  integration stack still selects the image via `PDNS_AUTH_IMAGE`.

### Fixed

- The **TSIG keys** admin page (`/admin/tsig-keys`) was unreachable — `tsig.read` was granted by
  no role, so even Super Admin got bounced to the dashboard. It's now granted alongside
  `tsig.manage` (Team Owner and above); the boot seed rewrites system-role permissions, so a
  redeploy fixes existing installs.
- **TSIG cascade-delete on a renamed/dotted key.** The pre-check that detaches a TSIG key from
  zones still referencing it compared a dot-less key name against PowerDNS's trailing-dot zone
  key-id fields, so the detach could be skipped. Key-name handling is now normalized through a
  single `stripTrailingDot` helper.
- **Self-contention against a backend store.** The background poll (reads) and the request path
  (writes) could hit the same backend simultaneously; on a single-file gsqlite3 store a reader can
  stall a writer into a transient HTTP 500. The app now coordinates per backend — the poll's reads
  and the request path's writes take turns (keyed per backend; interactive reads stay fully
  concurrent, and separate backends never block each other), so the app no longer contends with
  itself. No PowerDNS configuration change required.
- **An unreachable backend no longer wedges the UI.** The background poll and the explicit
  Test/Refresh now use a fast-fail probe (one attempt, 5s timeout) instead of the write-path's
  3 attempts × 10s, so a newly-added or down backend resolves to "unreachable" in seconds rather
  than stalling the zones/servers pages (which await the poll) or the Test toast for ~30s.
  User-initiated reads and writes keep the full retry resilience.

## [1.0.2] — 2026-05-23

### Changed

- **Project moved to the [`PowerDNS-AuthAdmin`](https://github.com/PowerDNS-AuthAdmin) GitHub
  organization, and container images are now published to the GitHub Container Registry (GHCR)
  instead of Docker Hub.** Pull `ghcr.io/powerdns-authadmin/powerdns-authadmin:latest` (or a
  `:X.Y.Z` tag). The previous Docker Hub repository is no longer updated.

## [1.0.1] — 2026-05-23

### Fixed

- The dashboard "PDNS backends needing attention" widget and the PowerDNS-servers Status column
  no longer flag healthy backends as stale/unreachable. Reachability now tracks a `last_seen_at`
  timestamp, bumped on every successful background poll (and on a manual Test / Refresh all),
  instead of the version-probe timestamp — which only moved on a manual probe and so went "stale"
  within 24h even while the backend was being polled successfully every 30s.

### Changed

- An OIDC provider configured via `OIDC_*` environment variables now appears as a **read-only**
  provider badged "Configured by ENV" — shown on the login page and in **Admin → OIDC providers**
  alongside DB-backed providers, instead of being a hidden fallback that only surfaced when no DB
  providers existed. A DB provider with the same slug still shadows it.

### Added

- A documentation set under [`docs/`](./docs/): Quickstart, Installation, Configuration, Backends,
  OIDC, Provisioning, RBAC, Hardening, Upgrading, and Troubleshooting guides.
- Sidebar footer showing the running version (linked to its GitHub release) and a Docs link pinned
  to the matching version's `docs/`.

## [1.0.0] — 2026-05-22

First production release.

### Added

- **Multi-backend management** — standalone primaries, primary + secondaries groups, and
  multi-primary clusters from one app, with per-cluster peer-selection strategies
  (round-robin / random / lowest-latency / least-load).
- **RBAC** (CASL) — five system roles plus custom roles; ~60 permissions scoped global / team /
  zone / server.
- **Authentication** — local accounts (Argon2id), generic OIDC SSO with PKCE + group→role mapping
  and RP-initiated logout, TOTP MFA with a per-user override, and scoped `pda_pat_` API tokens.
- **Zones & records** — per-RRset editor with diff-before-apply, per-type validators, zone cloning,
  zone templates, and optimistic concurrency.
- **DNSSEC, TSIG, autoprimaries** management.
- **Sync probes** — serial + record-for-record comparison for primary/secondary groups and clusters.
- **Append-only audit log** with redacted before/after snapshots and per-zone history.
- **Transactional email** — email verification, password reset, and email-change confirmation (SMTP).
- **First-boot provisioning** — YAML-driven setup of settings, roles, teams, templates, servers,
  clusters, demo zones, and OIDC providers.
- **Storage** — SQLite or Postgres; migrations run automatically on boot.
- **Observability** — Pino structured logs, Prometheus `/metrics`, `/healthz` + `/readyz` probes.
- **Distribution** — multi-arch (`linux/amd64` + `linux/arm64`) image published to Docker Hub as
  `jseifeddine/powerdns-authadmin`, plus a one-command minimal-demo stack.

[Unreleased]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.5...HEAD
[1.1.5]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.4...v1.1.5
[1.1.4]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.3...v1.1.4
[1.1.3]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.2...v1.1.3
[1.1.2]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.1...v1.1.2
[1.1.1]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/releases/tag/v1.0.0
