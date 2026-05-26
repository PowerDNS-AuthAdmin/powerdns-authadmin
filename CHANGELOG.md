# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
- **`(i)` polling-mode hint** on the dashboard heading when polling is
  off — hover tooltip explains the current state and links to the live
  CONFIGURATION doc.
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
