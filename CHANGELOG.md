# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/jseifeddine/powerdns-authadmin/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/jseifeddine/powerdns-authadmin/releases/tag/v1.0.0
