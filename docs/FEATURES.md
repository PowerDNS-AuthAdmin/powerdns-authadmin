# Features

A complete tour of what PowerDNS-AuthAdmin does, grouped by concern, with module pointers so you
can jump straight into the code that owns each feature.

> **Reading this document.** Each section starts with **what** the feature does, then **where**
> the code lives, then **how** to use / configure it. If you want a quickstart, read the
> [README](../README.md) first.

> **Visual tour.** Every page below is captured in light + dark, desktop + iPhone-framed mobile,
> in [`screenshots/`](../screenshots/README.md). Inline shots in this doc auto-switch theme to
> match your reader; click through for the mobile variant.

---

## 1. Authentication

### 1.1 Local accounts (email + password)

- **What.** Sign in with email + Argon2id-hashed password. OWASP 2024 parameters. Hashes are
  re-derived (`needsRehash`) on every successful login if the parameter set has been tightened.
- **Where.** `lib/auth/password.ts`, `lib/auth/providers/local.ts`, `app/api/auth/login/route.ts`,
  `app/(auth)/login/`.
- **How.**
  - Bootstrap the first admin via `BOOTSTRAP_ADMIN_EMAIL` + `BOOTSTRAP_ADMIN_PASSWORD` env (see
    `.env.example`). The seed is idempotent — keyed on the email, it ensures that account exists
    and never clobbers an existing one.
  - Add more users from `/admin/users` (gated on `user.create`). The admin can issue a
    one-time temporary password that forces the user to change on first login.
  - Lockout policy is operator-tunable: `login_lockout_threshold` (1–100 attempts) and
    `login_lockout_seconds` (60–86400) on the admin Settings page.
  - The login path is constant-time even when the user doesn't exist — defends against email
    enumeration.

### 1.2 OIDC SSO

- **What.** Generic OIDC (Authorization Code + PKCE) via `openid-client`. Multiple providers
  configurable per install. Discovery happens at sign-in; the AS metadata is cached in-process.
  Auto-detects whether the IdP wants `client_secret_basic` or `client_secret_post`; falls back
  to the other method on `invalid_client` so an IdP whose advertised list disagrees with its
  per-client config still works.
- **Where.** `lib/auth/providers/oidc.ts`, `lib/auth/providers/oidc-probe.ts`,
  `app/api/auth/oidc/[provider]/{initiate,callback}/route.ts`,
  `app/(app)/admin/oidc-providers/`.
- **How.**
  - Add a provider from `/admin/oidc-providers` (gated on `oidc.manage`).
  - The redirect URI to register with the IdP is `${APP_URL}/api/auth/oidc/<slug>/callback`.
  - Per-provider toggles:
    - `enabled` — hides the provider from the login page when off.
    - `force_default` — `/login` auto-redirects here instead of showing the form. Escape hatch
      is `/login?force-local=1`.
    - `require_email_verified` — default on; sign-in is blocked unless the IdP attests
      `email_verified: true`. Defends against account-takeover when the same email exists
      locally and the IdP lets users set arbitrary unverified emails. Relax it only for IdPs
      that never emit the claim.
    - `allowed_email_domains` — per-provider override of the env-level allow-list.
  - Discovery health is operator-pollable via the **Test** button on the providers list AND
    the edit page; the result is cached on the row's `discovery_cache` field.
  - **RP-initiated logout.** When the IdP advertises an `end_session_endpoint`, sign-in
    captures it + the raw id_token on the session row. Logout navigates the browser to
    `<end_session_endpoint>?id_token_hint=…&client_id=…` so the IdP ends its own session and
    renders its signed-out screen. No `post_logout_redirect_uri` is sent — most IdPs require
    it pre-registered and silently strip it otherwise.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/oidc-providers.png" />
  <img src="../screenshots/light/oidc-providers.png" alt="OIDC providers" width="720" />
</picture>

### 1.3 Group → role mapping (OIDC)

- **What.** Materialise role assignments from a user's IdP group claim on every sign-in.
  Assignments tagged with `provider_id` get reconciled on the next sign-in: groups the user
  no longer holds revoke the assignment, admin-issued assignments are never touched.
- **Where.** `lib/auth/providers/oidc-group-sync.ts`,
  `app/(app)/admin/oidc-providers/_components/oidc-provider-form.tsx` (the editor).
- **How.** From a provider's edit page, add rows under **Group → role mappings**: each row pairs
  an IdP group name with a role + scope. Scope syntax is `global`, `team:<slug>`,
  `zone:<fqdn>`, or `server:<slug>`. Mappings whose role/team/server can't be resolved at
  sign-in are logged + audited (`auth.oidc.group_sync.mapping_unresolved`) and skipped — the
  sign-in still succeeds.

### 1.4 TOTP (multi-factor)

- **What.** Self-service TOTP enrollment for local-password users. Inline SVG QR code rendered
  server-side via `qrcode`; manual setup-key fallback shown alongside. Standard RFC 6238 with
  SHA-1, 30s step, ±1 step skew tolerance, hand-rolled HOTP/Base32 in
  `lib/auth/totp.ts` to avoid an extra dependency.
- **Where.** `lib/auth/totp.ts`, `lib/auth/totp-qr.ts`,
  `app/(app)/profile/_components/totp-section.tsx`, `app/api/profile/mfa/totp/route.ts`,
  `app/api/auth/login/route.ts` (challenge step).
- **How.** From `/profile#mfa`, click **Enable TOTP**, scan the QR with any authenticator app,
  confirm the 6-digit code. Per-role `requires_mfa` enforcement (set on the role edit page)
  redirects non-enrolled users to `/profile?mfa-required=1` until they finish enrolment.
  **SSO-only users** (no local password) see a read-only "Managed by your identity provider"
  panel and are exempt from the `requires_mfa` gate — the IdP is their second-factor authority.

### 1.5 API tokens

- **What.** Per-user `pda_pat_…` tokens with operator-selected permission scopes from the
  user's effective set. Argon2id-hashed at rest, public prefix indexable for lookups.
- **Where.** `lib/auth/tokens.ts`, `lib/db/repositories/api-tokens.ts`,
  `app/(app)/profile/_components/api-tokens-section.tsx`,
  `app/(app)/admin/users/_components/tokens-panel.tsx`,
  `app/api/profile/api-tokens/`.
- **How.** From `/profile#api-tokens`, **Create token**, pick scopes + optional expiry. The
  plaintext value is shown ONCE and never round-tripped again. Use the token by sending it
  as `Authorization: Bearer pda_pat_…` or `X-API-Key: pda_pat_…`. Admins with `token.read.all`
  see every user's token inventory under `/admin/users/<id>/tokens`.

### 1.6 Sessions

- **What.** DB-backed sessions (ADR 0007) with encrypted-opaque cookie carrying the row id.
  CSRF via double-submit cookie pair (`csrf_secret` on the row + `csrf` cookie + `x-csrf-token`
  header verified constant-time).
- **Where.** `lib/auth/session.ts`, `lib/auth/csrf.ts`, `lib/db/schema/sessions.ts`.
- **How.** The per-user **Active sessions** panel at `/profile#sessions` lists every browser
  cookie tied to your account with its IP, last-seen timestamp, and a revoke button. Admins
  manage other users' sessions from `/admin/users/<id>/sessions` (gated on `user.update`).

### 1.7 Rate limiting

- **What.** Token-bucket per IP for the login + sensitive endpoints. Bounded map size so a
  malicious peer can't OOM the rate-limiter map.
- **Where.** `lib/auth/rate-limit.ts`.
- **How.** Operator-tuneable thresholds live in the same module. Client IP for keys comes
  from the fronting proxy's `X-Forwarded-For`/`X-Real-IP` (`lib/client-ip.ts`); deploy behind a
  proxy that overwrites client-supplied XFF.

---

## 2. RBAC

### 2.1 Permissions vocabulary

- **What.** A typed list of ~60 permission strings spanning every action surface: zones,
  records, DNSSEC, metadata, TSIG, autoprimaries, templates, users, teams, roles, PDNS
  servers, API tokens, audit, settings, OIDC providers.
- **Where.** `lib/rbac/permissions.ts`.
- **How.** Use a permission in a route via `requireUser({ can: "zone.create" })` or in a page
  component via `requireUserForPage({ can: "zone.create" })`. The CASL ability builder
  (`lib/rbac/ability.ts`) enforces it.

### 2.2 System + custom roles

- **What.** Five system roles are seeded (`super-admin`, `team-owner`, `operator`,
  `zone-editor`, `read-only`). Custom roles are operator-defined via `/admin/roles` (gated on
  `role.create`).
- **Where.** `lib/rbac/default-roles.ts`, `lib/db/schema/roles.ts`,
  `app/(app)/admin/roles/`.
- **How.** Each role carries `permissions` (array of strings from the vocab) + `requires_mfa`
  (forces TOTP enrolment for any user assigned to this role).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/roles.png" />
  <img src="../screenshots/light/roles.png" alt="Roles" width="720" />
</picture>

### 2.3 Scoped assignments

- **What.** Every assignment is `(user, role, scope)` where scope is one of
  `global` / `team:<id>` / `zone:<fqdn>` / `server:<id>`. The CASL builder walks scopes at
  request time so an operator with `record.update` on `zone:example.com.` can edit records
  there but nowhere else.
- **Where.** `lib/rbac/ability.ts`, `lib/rbac/policy.ts`,
  `lib/db/schema/role-assignments.ts`, `lib/db/schema/zone-grants.ts`.
- **How.** Issue assignments from `/admin/users/<id>` (gated on `role.assign`) OR auto-issue
  via OIDC group mapping (see § 1.3). The `provider_id` column distinguishes admin-issued
  from OIDC-sourced; only OIDC-sourced ones get reconciled on sign-in.

---

## 3. PowerDNS backends

### 3.1 Multi-backend management

- **What.** The app fronts one or many PDNS Authoritative servers. Three topologies are
  supported and visible side-by-side:
  - **Standalone primary** — single instance, no replication.
  - **Primary + secondaries** — one writable, N read-only mirrors auto-bootstrapped via
    PDNS supermaster + NOTIFY/AXFR.
  - **Multi-primary cluster** — N writable peers sharing a replicated backend (e.g. Galera
    MariaDB). Cluster appears as ONE entry in every selector.
- **Where.** `lib/db/schema/pdns-servers.ts`, `lib/db/schema/pdns-clusters.ts`,
  `lib/db/repositories/{pdns-servers,pdns-clusters,selectable-backends}.ts`,
  `app/(app)/admin/{servers,pdns-clusters}/`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/powerdns-servers.png" />
  <img src="../screenshots/light/powerdns-servers.png" alt="PowerDNS servers" width="720" />
</picture>

### 3.2 Per-cluster peer-selection strategy

- **What.** When operating on a cluster, both reads AND writes route to a peer chosen by the
  cluster's strategy:
  - `round_robin` — spread requests in order.
  - `random` — uniform random.
  - `lowest_latency` — peer with the lowest p50 from the sampler (falls back to round-robin
    until samples exist).
  - `least_load` — peer with the fewest zones from the sampler.
- **Where.** `lib/pdns/cluster-picker.ts`, `lib/pdns/cluster-picker-pure.ts`.
- **How.** Picked from the cluster edit page under **Peer selection strategy**. The column
  in the DB is `write_strategy` (legacy name preserved); the UI label is "Peer selection
  strategy" since it governs both reads and writes.

### 3.3 Sync probes

- **What.** Two flavours, identical visual shape:
  - **Primary + secondaries.** Compare each secondary's serial against the primary's;
    on-demand rrset diff for any zone that disagrees. Status chip in the zones table.
  - **Cluster.** Compare every peer's serial against the highest-serial peer (used as
    source-of-truth on disagreement, since there's no canonical primary). Same rrset diff
    on demand.
- **Where.** `lib/pdns/sync.ts`, `lib/pdns/cluster-sync.ts`,
  `app/(app)/zones/[zoneId]/_components/sync-section.tsx`.

### 3.4 NOTIFY-on-write + convergence sweep

- **What.** Every code path that creates a zone goes through `createZoneAndNotify()` which
  fires NOTIFY to all secondaries after the create. The provisioning loop additionally runs
  a convergence sweep after all demo zones are created — re-NOTIFYs every Master/Primary
  zone on each touched backend. This catches the docker-compose race where the first zones
  get created before secondaries have registered themselves as supermasters and miss the
  initial NOTIFY.
- **Where.** `lib/pdns/operations.ts`.

### 3.5 PDNS HTTP client

- **What.** Typed thin wrapper over PDNS's HTTP API: zones.list / get / create, rrsets PATCH,
  cryptokeys, metadata, TSIG, autoprimaries, server.info, statistics. Version cache +
  capability flags so feature gates (catalog zones, DNSSEC) reflect the real backend version.
  Retries with backoff, typed error hierarchy (`PdnsError` / `PdnsNotFoundError` /
  `PdnsConflictError`).
- **Where.** `lib/pdns/client.ts`, `lib/pdns/registry.ts`, `lib/pdns/types.ts`,
  `lib/pdns/errors.ts`.

### 3.6 PDNS request log

- **What.** Every HTTP call the app issues to PowerDNS is recorded with timestamp, server,
  operation, method, URL, response status, error (if any), and the correlator `requestId` of
  the audit row that triggered it. Visible at `/admin/pdns-requests` with filters for server,
  op, status code, request id, and date range. Each row expands inline to the full request +
  response detail; the `req:` link cross-pivots to / from the matching audit row, so an audit
  failure is one click from the exact PDNS exchange.
- **Where.** `lib/pdns/request-log.ts`, `app/(app)/admin/pdns-requests/`,
  `lib/db/repositories/pdns-requests.ts`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/pdns-requests.png" />
  <img src="../screenshots/light/pdns-requests.png" alt="PDNS request log" width="720" />
</picture>

### 3.7 Backend health advisories

- **What.** A bell in the top header surfaces active advisories computed every poll cycle:
  unreachable backends, API-key rejections (401/403), replication drift past a threshold, TSIG
  keys missing on a secondary, mirror zones without `masters`, daemon-config drift between
  peers. Acknowledged advisories disappear automatically when the underlying condition
  resolves. Same signal feeds the per-row red/warn tints on
  [PowerDNS servers](#31-multi-backend-management) — bell and table never disagree.
- **Where.** `lib/health/evaluator.ts`, `components/domain/health-bell.tsx`,
  `lib/db/repositories/backend-advisories.ts`. Decision record:
  [ADR-0015](./adr/0015-backend-health-advisories.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/backend-health.png" />
  <img src="../screenshots/light/backend-health.png" alt="Backend health bell popover" width="720" />
</picture>

### 3.8 SSRF guard

- **What.** Config-time + runtime IP-range checks on PDNS `base_url`. Link-local
  (incl. 169.254.169.254 cloud metadata) is always blocked. Private networks gated by
  `APP_PDNS_ALLOW_PRIVATE_NETWORKS`; `http://` gated by `APP_PDNS_ALLOW_INSECURE_HTTP`.
  At request time the guard re-resolves the host and **pins the validated IP into
  the connection**, so undici reaches the exact address the guard checked (closes
  the DNS-rebinding window).
- **Where.** `lib/pdns/url-safety.ts` (the guard); `lib/pdns/http.ts` (request-time
  re-check + pinned dispatcher).

---

## 4. Zones

### 4.1 Amalgamated zones list

- **What.** Every zone across every backend in one list. Per-row "Backend" column. Per-row
  Sync chip: "—" for standalones, "synced/desynced (N)" for primaries with secondaries and
  for clusters.
- **Where.** `app/(app)/zones/page.tsx`, `app/(app)/zones/_components/zones-table.tsx`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/zones-list.png" />
  <img src="../screenshots/light/zones-list.png" alt="Amalgamated zones list" width="720" />
</picture>

### 4.2 Per-RRset editor with diff-before-apply

- **What.** Edit records inline; the editor batches changes into a single transactional PATCH
  to PDNS with an audit row carrying full before/after JSONB snapshots. Every change runs
  through a **Review changes** modal that previews the BIND-style before/after diff — Save is
  the second click, never the first.
- **Where.** `app/(app)/zones/[zoneId]/_components/editable-record-table.tsx`,
  `app/api/admin/pdns/zones/[zoneId]/rrsets/route.ts`.
- **How.** Per-RR-type validators live in `lib/validators/rr-types/` and run on every change
  pair. Hard-error for shape/range violations; soft-warn for deprecated-but-legal options
  (DS digest-type 1, SSHFP DSA, SVCB unknown SvcParamKey, etc.). Hard errors are gated by an
  explicit **Save anyway** checkbox so an override is always intentional and audited verbatim.

<table>
  <tr>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/zone-edit.png" />
        <img src="../screenshots/light/zone-edit.png" alt="Edit record dialog" />
      </picture>
      <br /><sub>Edit dialog — Name / Type / TTL / Value with per-type structured editors.</sub>
    </td>
    <td>
      <picture>
        <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/zone-edit-diff.png" />
        <img src="../screenshots/light/zone-edit-diff.png" alt="Review changes diff" />
      </picture>
      <br /><sub>Review changes — every save previewed as a before/after diff.</sub>
    </td>
  </tr>
</table>

### 4.3 Zone clone

- **What.** Copy a zone's rrsets into a new zone name on the same backend. The new zone
  ships with the original's records (sans SOA, which PDNS regenerates).
- **Where.** `app/api/admin/pdns/zones/clone/route.ts`, `lib/pdns/clone.ts`.

### 4.4 Zone templates

- **What.** Reusable scaffolding for new zones: NS records, SOA timers, prelude records,
  zone-object settings (`soa_edit`, `soa_edit_api`, `api_rectify`), per-kind metadata bag.
  Templates can be `default_for_primary_slugs` so the create-zone form preselects them when
  the operator picks one of the listed backends.
- **Where.** `lib/db/schema/zone-templates.ts`, `lib/validators/zone-templates.ts`,
  `app/(app)/admin/zone-templates/`.

### 4.5 Zone change history

- **What.** Per-zone history feed at `/zones/<id>?tab=history` rendering every audit event
  with diff (rrset before/after) and one-line summaries for DNSSEC / metadata events. Chip
  colours match the action vocabulary's tone (`lib/audit/action-color.ts`).
- **Where.** `app/(app)/zones/[zoneId]/_components/zone-change-log.tsx`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/zone-change-history.png" />
  <img src="../screenshots/light/zone-change-history.png" alt="Zone change history" width="720" />
</picture>

---

## 5. DNSSEC

- **What.** Cryptokey create / update / delete with per-key activity timestamps derived from
  the audit log. Summary card + per-key list at `/zones/<id>?tab=dnssec`.
- **Where.** `app/(app)/zones/[zoneId]/_components/dnssec-section.tsx`,
  `app/api/admin/pdns/zones/[zoneId]/cryptokeys/`.

---

## 6. Zone metadata

- **What.** Per-kind GET / PUT / DELETE under `/api/admin/pdns/zones/[zoneId]/metadata/[kind]`.
  Surfaced as `<MetadataEventLine>` entries on the zone change-history feed.
- **Where.** `app/(app)/zones/[zoneId]/_components/metadata-section.tsx`,
  `app/api/admin/pdns/zones/[zoneId]/metadata/`.

---

## 7. TSIG keys

- **What.** Manage shared-secret keys for AXFR + DDNS. Permission model splits `tsig.read`
  (list-only — name + algorithm) from `tsig.manage` (create / regenerate / reveal / delete)
  so an operator can audit the inventory without ever seeing the secret material.
- **Where.** `lib/pdns/tsigkeys.ts`, `app/(app)/admin/tsig-keys/`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/tsig-keys.png" />
  <img src="../screenshots/light/tsig-keys.png" alt="TSIG keys" width="720" />
</picture>

---

## 8. Autoprimaries

- **What.** Configure supermaster registrations on a secondary PDNS so it auto-creates zones
  on NOTIFY from a registered primary.
- **Where.** `lib/pdns/autoprimaries.ts`, `app/(app)/admin/servers/[id]/_components/autoprimaries-panel.tsx`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/autoprimaries.png" />
  <img src="../screenshots/light/autoprimaries.png" alt="Autoprimaries" width="720" />
</picture>

---

## 9. Audit log

- **What.** Append-only log of every state-changing operation. Each row carries actor, action,
  resource, optional before/after JSONB snapshots, request context (IP, user-agent, request
  id), and a timestamp. Snapshots are auto-redacted for known secret field names.
- **Where.** `lib/audit/log.ts`, `lib/audit/actions.ts` (typed vocab), `lib/audit/redact.ts`,
  `app/(app)/admin/audit/`.
- **How.** Filter by actor, action, resource, time range from `/admin/audit` (gated on
  `audit.read`). Per-resource "Last admin edit" columns on every admin list page are derived
  from one batched query. Quick-filter chips cover the common incident-response queries
  (failed sign-ins, MFA admin changes, session revocations). Every row that originated a PDNS
  call carries a `req:` link that pivots to the matching rows in
  [the PDNS request log](#36-pdns-request-log), and CSV export honours the active filters.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/audit-log.png" />
  <img src="../screenshots/light/audit-log.png" alt="Audit log" width="720" />
</picture>

---

## 10. Settings

- **What.** Operator-tunable runtime values: site name, support contact, login intro text,
  brand logo (https:// URL or inline data: URI), failed-login lockout policy.
- **Where.** `lib/validators/settings.ts`, `app/(app)/admin/settings/`,
  `lib/settings/app-settings.ts`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/settings.png" />
  <img src="../screenshots/light/settings.png" alt="Settings" width="720" />
</picture>

---

## 11. Dashboard

- **What.** At-a-glance widgets for operator attention surfaces:
  - **Users** — locked-out, no-MFA, unverified, must-change-password counts.
  - **PDNS backends** — never probed, stale > 24h.
  - **OIDC providers** — never probed, failing.

  Widgets are hidden when zero, so the dashboard stays quiet during steady-state.

- **Where.** `app/(app)/dashboard/page.tsx`,
  `lib/db/repositories/dashboard.ts`.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/dashboard.png" />
  <img src="../screenshots/light/dashboard.png" alt="Dashboard" width="720" />
</picture>

---

## 12. Provisioning (first-boot YAML)

- **What.** A YAML file applied on first boot writes the operator's declarative state into the
  database: settings, custom roles, teams, zone templates, PDNS clusters, PDNS servers, demo
  zones, OIDC providers (with group mappings). The applier writes a `settings.provisioned_at`
  sentinel on success; subsequent restarts skip the file.
- **Where.** `lib/provisioning/schema.ts` (Zod schema), `lib/provisioning/apply.ts`,
  `provisioning.example.yaml` (exhaustive reference).
- **How.** Set `PROVISIONING_FILE=/etc/.../provisioning.yaml` in the env, drop the file at
  that path, restart. To re-provision an existing database, delete the
  `settings.provisioned_at` row and restart.

---

## 13. Email / SMTP

- **What.** Optional transactional mail. With `SMTP_HOST` unset, `sendEmail()` no-ops with
  `{ ok: true, skipped: true }`. With it set, three encryption shapes are supported:
  implicit TLS (`SMTP_SECURE=true`), STARTTLS required, STARTTLS opportunistic (default), or
  plaintext-only for local fakemail. AUTH is optional — omit `SMTP_USERNAME` + `SMTP_PASSWORD`
  for a relay that allow-lists this app's source IP.
- **Where.** `lib/email/transport.ts`, `lib/email/send.ts`, env validation in `lib/env.ts`.

---

## 14. Realtime

- **What.** SSE event bus that the zone list + zone detail subscribe to so external edits show
  up without a manual refresh. Backed by a single in-process zone-state poller; per-request
  PDNS calls are eliminated.
- **Where.** `lib/realtime/event-bus.ts`, `lib/realtime/zone-poller.ts`,
  `lib/realtime/zone-state-cache.ts`.

---

## 15. Observability

- **What.**
  - **Logs.** Pino structured JSON; secret-field redaction via `lib/errors/redact.ts`.
  - **Metrics.** Prometheus `/metrics` (optional bearer-token gate via `METRICS_TOKEN`).
  - **Health.** `/healthz` (liveness) + `/readyz` (readiness — fails on DB unreachable or
    pending migrations).
- **Where.** `lib/logger.ts`, `app/metrics/`, `app/healthz/`, `app/readyz/`.

---

## 16. Deployment

### 16.1 Single image

- **What.** One Docker image, no external CDN. Migrations run in the entrypoint at boot
  (ADR 0011); on Postgres they're serialized by `pg_advisory_lock` so multi-replica boots are
  safe. `MIGRATE_ON_BOOT=false` opts out for CI/CD-driven migration workflows.
- **Where.** `Dockerfile`, `docker/entrypoint.mjs`, `scripts/migrate.ts`.

### 16.2 Compose stacks

All stacks use the official `powerdns/pdns-auth` image — there is no custom PowerDNS build.

- `docker-compose.yml` — the **minimal-demo stack**: SQLite app (published
  `ghcr.io/powerdns-authadmin/powerdns-authadmin` image) + a bundled standalone PowerDNS, pre-seeded with 10 demo
  zones (via `provisioning.minimal-demo.yaml`). The fastest way to try it.
- `docker-compose-primary-secondaries.yml` — primary + three secondaries with supermaster
  auto-bootstrap.
- `docker-compose-multi-primary.yml` — three writable peers sharing MariaDB.
- `docker-compose-combined.yml` — all three topologies in one stack with seeded demo zones.

### 16.3 Storage

Postgres (recommended) and SQLite both supported. Schema lives in parallel
`lib/db/schema/` (pg) + `lib/db/schema-sqlite/` directories. Each emits its own migration
folder (`drizzle/`, `drizzle-sqlite/`); the boot entrypoint picks one based on
`DATABASE_URL`'s scheme.

---

## 17. Security posture

- **Per-request CSP nonce** (ADR 0006) so injected `<script>` tags don't execute.
- **CSRF double-submit** on every mutating route via `requireCsrf(request)`.
- **SSRF guard** on PDNS base URLs (§ 3.8).
- **Encryption envelope** for at-rest secrets — versioned AES-256-GCM via HKDF-SHA-256
  subkeys per usage (`lib/crypto/encryption.ts`).
- **Secret-field redaction** in audit `before`/`after` snapshots and free-form log strings.
- **Argon2id** with OWASP 2024 parameters for passwords and API tokens.
- **No telemetry phone-home.** Air-gapped enterprises are first-class.
- **`SECURITY.md`** for the vulnerability disclosure policy.

---

## 18. API

- Every admin surface has a corresponding `/api/admin/...` route handler. Routes accept
  either a session cookie (UI clients) or `Authorization: Bearer pda_pat_…` /
  `X-API-Key: pda_pat_…` (API clients).
- Mutating routes require `x-csrf-token`. The client wrapper `lib/client/api-fetch.ts` adds
  it automatically; programmatic clients omit it when authenticating via a PAT (the PAT itself
  proves the request is intentional).
- The full route surface mirrors the admin UI — see `app/api/admin/` and `app/api/profile/`.

---

## 19. Operator UX & responsive design

Landed in v1.1.4 ([#51](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/issues/51) /
[PR #52](https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/pull/52)) — a top-to-bottom
pass to make the operator surface usable on phones without giving up the dense desktop
information density. Every screenshot in [`screenshots/`](../screenshots/README.md) is from
this baseline.

### 19.1 Mobile-first responsive shell

- **What.** Off-canvas hamburger drawer for navigation under `md`; full sidebar from `md+`.
  Drawer closes on backdrop tap, Esc, and route changes (no in-drawer close button needed).
  The top bar reflows: hamburger + status chip + bell + theme + avatar, all reachable at
  320 px.
- **Where.** `components/ui/app-shell.tsx`, `app/(app)/layout.tsx`.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/dashboard-mobile.png" />
    <img src="../screenshots/light/dashboard-mobile.png" alt="Dashboard on mobile" width="240" />
  </picture>
  &nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../screenshots/dark/zones-list-mobile.png" />
    <img src="../screenshots/light/zones-list-mobile.png" alt="Zones list on mobile" width="240" />
  </picture>
</p>

### 19.2 One DataTable, every list

- **What.** Every list view (zones, users, roles, teams, OIDC providers, TSIG keys,
  autoprimaries, zone templates, audit log, PDNS request log, sessions, profile sessions,
  servers, dashboard sub-tables, role assignments, team members, zone change history) uses
  the same `<DataTable>` recipe. Desktop: `bg-bg-muted` thead, `even:bg-bg-subtle` striping,
  accent-tinted hover wash, sticky search + sort + per-column meta widths. Mobile (< md):
  each row reflows to a labelled card automatically — no horizontal scroll, no truncated
  cells.
- **Where.** `components/ui/data-table.tsx`. The Audit Log + Profile Sessions + OIDC
  Providers + TSIG Keys + Autoprimaries were the final hold-outs converted in v1.1.4.

### 19.3 Live header status chip

- **What.** Single pill in the top bar showing `CONNECTING / CONNECTED / OFFLINE / PAUSED`
  (SSE connection state) plus a trailing `· SYNCED / · DESYNCED` whenever the page has a
  notion of sync state. Off-the-shelf default is the fleet-wide `globalAnyLagging()` verdict
  computed from the in-process zone-state cache (no extra PDNS hit); per-page
  `<HeaderStatusMode/>` overrides on zone-detail, zones-list, and the servers page. A 5 s
  grace prevents "OFFLINE" flashes on Ctrl-R.
- **Where.** `components/realtime/header-status-chip.tsx`,
  `components/realtime/realtime-provider.tsx`, `lib/pdns/sync.ts` (`globalAnyLagging`).

### 19.4 Animated SyncIndicator

- **What.** Concentric-ring SVG glyph used everywhere a sync verdict is displayed (header
  chip, zones list per-row chip, servers table). **Synced** = solid centre + two
  outward-pulsing rings via staggered CSS keyframes — a continuous radar/sonar ping.
  **Desynced** = hollow centre + two dashed concentric rings that counter-rotate via
  `stroke-dashoffset` so the icon reads as _actively trying_ rather than as a frozen error.
  Honours `prefers-reduced-motion`.
- **Where.** `components/ui/sync-indicator.tsx`, `app/globals.css` (`pda-sync-pulse` +
  `pda-desync-spin*` keyframes).

### 19.5 One-button theme toggle

- **What.** Was three buttons (sun / monitor / moon). Now one button whose icon mirrors the
  active preference and cycles `light → dark → system → light` on click. The pre-hydration
  script in `app/layout.tsx` still applies the `.dark` class before React mounts so there's
  no flash of wrong theme.
- **Where.** `components/ui/theme-toggle.tsx`.

### 19.6 Capability badges + clickable rows

- **What.** Per-backend badges (`CLUSTER` / `DEFAULT` / `PRIMARY` / `READ-ONLY MIRROR`) match
  the visual vocabulary across servers, zones, audit. Every table row + mobile card is
  clickable to the detail view; embedded links/buttons (Edit / Delete / Refresh) intercept the
  click so per-row actions still work.
- **Where.** `components/domain/capability-badges.tsx`, `components/ui/clickable-row.tsx`.

### 19.7 Diff-before-apply (record edits)

The per-RRset editor now insists on a **Review changes** modal between Save and the actual
PATCH — see [§ 4.2](#42-per-rrset-editor-with-diff-before-apply) for the full story. Validation
errors are gated behind an explicit "Save anyway" checkbox so an override is never accidental.

### 19.8 Compliance hard-stops

- **What.** Operators with `must_change_password = true` or unmet MFA-per-role requirements
  are pinned to `/profile` (or an allow-list of self-service routes) on every navigation —
  not just the initial render. The header status chip is suppressed in that state because
  the SSE endpoint would 403 the request, which would otherwise leave the chip stuck on
  `CONNECTING`.
- **Where.** `lib/auth/require-user.ts` (page gate), `app/(app)/layout.tsx` (compliance
  redirect), `components/auth/must-change-password-guard.tsx` (client-side intercept).
