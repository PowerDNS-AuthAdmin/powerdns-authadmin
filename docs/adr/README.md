# Architecture Decision Records

> **Why these exist.** Code preserves the _what_ but rots the _why_. ADRs preserve the _why_ so a
> future contributor can ask "why did they do it this way?" and get an answer without archaeology.

## How to use them

- **Read** any ADR whose subject touches the area you're changing before you change it.
- **Write** a new ADR when you make a decision that:
  - Adds, removes, or replaces a major dependency.
  - Changes an architectural pattern.
  - Constrains future choices in a non-obvious way.
- **Don't edit** ADRs after they're merged. Write a follow-up ADR that supersedes the old one
  (and update the old one's `Status` to `Superseded by NNNN`).

## Format

Copy `0000-template.md`. Keep ADRs short — one page is the target, two is the max. The point is
durability, not exhaustiveness.

## Index

| #    | Title                                                                                                            | Status                     |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 0001 | [Choose Next.js 15 + RSC as the framework](./0001-framework-choice.md)                                           | Accepted                   |
| 0002 | [License under MIT](./0002-mit-license.md)                                                                       | Accepted                   |
| 0004 | [Three-layer architecture (auth → RBAC → business)](./0004-three-layer-architecture.md)                          | Accepted                   |
| 0005 | [Migrations require explicit operator action](./0005-migrations-explicit.md)                                     | Superseded by 0011         |
| 0006 | [Per-request CSP nonce](./0006-csp-nonce.md)                                                                     | Accepted                   |
| 0007 | [DB-backed sessions over JWTs](./0007-db-backed-sessions.md)                                                     | Accepted                   |
| 0008 | [Argon2id for password hashing](./0008-argon2id-passwords.md)                                                    | Accepted                   |
| 0009 | [Custom auth core, not Auth.js](./0009-custom-auth-core.md)                                                      | Accepted                   |
| 0010 | [Per-RRset optimistic concurrency](./0010-per-rrset-optimistic-concurrency.md)                                   | Accepted                   |
| 0011 | [Migrations run at app-container boot](./0011-migrate-on-app-boot.md)                                            | Accepted (supersedes 0005) |
| 0012 | [First-boot provisioning + OIDC group→role mapping](./0012-first-boot-provisioning.md)                           | Accepted                   |
| 0013 | [PDNS client's sanctioned DB bridge + boundary enforcement fix](./0013-pdns-db-bridge.md)                        | Accepted                   |
| 0014 | [Per-zone authority + observed daemon capabilities (retire per-server role)](./0014-backend-capability-model.md) | Accepted                   |
| 0015 | [Backend health advisories (the notification bell)](./0015-backend-health-advisories.md)                         | Accepted                   |
| 0016 | [Optional Redis for horizontal scale (replicas > 1)](./0016-redis-horizontal-scale.md)                           | Accepted                   |
| 0017 | [Squash the 1.1.0 schema deltas into one migration per dialect](./0017-migration-squash-1.1.0.md)                | Accepted                   |

> **Numbering note:** there is no ADR 0003 — that number was reserved for a decision that was
> withdrawn before it was written. The gap is intentional; numbers are never reused.

> **Note:** ADR-0001 records the original choice of Next.js 15; the project has since upgraded to
> Next.js 16 (same App Router + RSC architecture). See the update note in that ADR.
