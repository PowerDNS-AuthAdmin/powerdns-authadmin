# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jseifeddine/powerdns-authadmin/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/jseifeddine/powerdns-authadmin/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jseifeddine/powerdns-authadmin/releases/tag/v1.0.0
