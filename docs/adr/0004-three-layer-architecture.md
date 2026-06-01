# ADR 0004 - Three-layer architecture (auth → RBAC → business logic)

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

Web apps that mix authentication, authorization, ORM access, upstream API calls, and template
rendering inside the same modules accumulate a class of regression where "seemingly simple changes
break multiple features." We pick a layout that makes that class of regression impossible to
introduce.

## Decision

Every request flows through **three independent layers**, in this order:

1. **Authentication.** Parse a session cookie OR a Bearer/X-API-Key token. Return `{ user, scopes }`
   or throw `UnauthorizedError`. Lives in `lib/auth/`.
2. **Authorization (RBAC).** Take `(user, action, resource)`, return allow/deny. Lives in
   `lib/rbac/`. Has no knowledge of how the user was authenticated.
3. **Business logic.** Call repositories (`lib/db/`) and the PDNS client (`lib/pdns/`). Write to
   the audit log (`lib/audit/`). Lives in the route handler / server action / server component
   that orchestrates the request.

Boundaries are enforced by ESLint `import/no-restricted-paths` rules in `eslint.config.mjs`. A
violation fails CI.

## Rationale

- **Single responsibility.** A reviewer reading an auth change doesn't have to know about RBAC.
  A reviewer reading a PDNS client change doesn't have to know about sessions.
- **Replaceable layers.** We can switch the auth provider, the RBAC engine, or the PDNS transport
  without touching the others.
- **Hard to bypass.** A contributor who instinctively reaches for `lib/db/` from a React
  component gets stopped by the linter before review.

## Alternatives considered

- **Single-tier monolith.** Rejected - mixed concerns are exactly the regression class we're
  trying to prevent.
- **More than three layers** (controllers / services / repositories / DTOs / mappers / …). Common
  in enterprise Java patterns. Rejected as over-engineering for an app of this size - adds
  ceremony without preventing real bugs.
- **Event-driven / CQRS.** Powerful but rarely necessary. Considered for the audit log; ended up
  using a simple synchronous write because the volume doesn't justify the complexity.

## Consequences

- Every route handler is short - input validation, auth, RBAC, business call, audit, response.
  Most are 20–30 lines.
- Cross-cutting concerns that span layers (request IDs, logging) flow through context-attached
  bindings rather than module imports.
- New contributors learn the layers first, then features. The lib/README.md files document each
  layer's role.

## References

- `eslint.config.mjs` (the enforcement)
- `CONTRIBUTING.md` § "Boundaries"
