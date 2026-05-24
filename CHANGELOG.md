# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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

[Unreleased]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.2...v1.1.0
[1.0.2]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/PowerDNS-AuthAdmin/powerdns-authadmin/releases/tag/v1.0.0
