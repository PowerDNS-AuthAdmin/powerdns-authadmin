# ADR 0009 — Roll our own auth core on `openid-client` + `argon2`, not Auth.js

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jadseifeddine

## Context

The obvious first choice for auth in a Next.js project is Auth.js v5 (NextAuth). On deeper
review the cost/benefit looks different:

- Auth.js v5's API has remained partly fluid through 2025, with credential providers and adapter
  contracts evolving across point releases.
- The library wraps several primitives we want to be explicit about — session cookie format,
  CSRF strategy, OIDC token validation, callback URL handling — and the wrapping makes auditing
  harder.
- An admin tool for DNS infrastructure has a particularly low tolerance for "magic" in the auth
  path. Every line of session and credential code should be ours to read in one sitting.

## Decision

We will **not** use Auth.js. Instead, the auth layer is built on a small set of focused primitives,
each chosen for being the reference / lowest-magic implementation in its space:

| Concern               | Library                                                          | Why this one                                                                                 |
| --------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| OIDC client           | `openid-client`                                                  | The reference Node OIDC client — what Auth.js wraps under the hood. Pinned, audited, no DSL. |
| Password hashing      | `argon2`                                                         | Wraps the reference Argon2id C implementation. ADR 0008.                                     |
| JWT / JOSE primitives | `jose`                                                           | Used only for OIDC ID-token validation, not for our own sessions. Wide adoption, audited.    |
| Session storage       | Drizzle + Postgres                                               | DB-backed (ADR 0007). We own the table and the lookup.                                       |
| Cookie encryption     | Node `crypto` AES-256-GCM via our own `lib/crypto/encryption.ts` | One implementation, used for at-rest secrets AND session cookies.                            |
| CSRF                  | Hand-rolled double-submit token                                  | Tiny code, easy to audit.                                                                    |
| RBAC                  | `@casl/ability`                                                  | Orthogonal to this ADR — we keep CASL for the ability engine.                                |

## Rationale

- **Auditability.** Every line of code on the auth path is in this repo. A new contributor can
  read `lib/auth/` end-to-end in an hour and know exactly what happens.
- **No version-churn surprises.** Auth.js v5's surface area still shifts; we're not signing up to
  track that churn for security-critical code.
- **No idiomatic mismatch.** Auth.js' provider model assumes patterns (database adapters, callback
  customization functions) that don't quite fit our explicit session table + audit log + RBAC
  scope-walking. Working around the assumptions ends up being more code than just writing the
  primitives ourselves.
- **Honest cost.** We pay ~500 lines of auth code we wouldn't have otherwise. That's a real cost
  but it's bounded; Auth.js' surface area is unbounded.

## Alternatives considered

- **Auth.js v5.** Considered the default, the original plan. Rejected per above.
- **Lucia.** Considered seriously — explicit, leaner, well-regarded. Rejected because it had
  publicly announced going into "maintenance mode" in 2024 (re-evaluating sustainability of the
  project), and we'd rather depend on a Node-standard library (`openid-client`) than a smaller
  abstraction that may need replacement.
- **Passport.js.** The long-running choice in Node-land. Rejected — Express-shaped middleware,
  doesn't fit our Next route-handler model, and its plugin ecosystem is uneven.

## Consequences

- `lib/auth/` is fully ours. Every change goes through the two-reviewer rule per
  `CONTRIBUTING.md` § Ground rules.
- The dependency tree is smaller: `openid-client` + `argon2` + `jose` + `@casl/ability` instead
  of a full Auth.js stack.
- Future providers (additional SAML, LDAP, WebAuthn) plug into the same provider interface
  defined by `lib/auth/providers/types.ts` — they don't pull in another framework adapter.

## References

- ADR 0007 (DB-backed sessions)
- ADR 0008 (Argon2id passwords)
- [`openid-client` on npm](https://www.npmjs.com/package/openid-client)
- [`jose` on npm](https://www.npmjs.com/package/jose)
