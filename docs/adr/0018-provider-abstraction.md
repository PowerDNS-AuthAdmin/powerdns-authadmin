# ADR 0018 - Multi-provider auth: keep OIDC where it is, layer SAML + LDAP as siblings

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** @jad-seifeddine

## Context

Today the app supports local password (Argon2id) sign-in and OIDC (via
`openid-client` v6). Adding SAML 2.0 and LDAP raises the question of how the
codebase should organise multiple auth providers. The existing OIDC layout has
distinct surfaces:

- A typed Provider concretion at `lib/auth/providers/oidc.ts`.
- A pair of HTTP route entry points at `/api/auth/oidc/<slug>/{initiate,callback}`.
- A DB-backed list of providers in the `oidc_providers` table (with envvar
  shadowing for an env-configured single-provider shim).
- A provider-aware admin UI under `/admin/oidc-providers/`.
- A `VerifiedIdentity` return shape on `lib/auth/providers/types.ts` that
  unifies the result of any provider before it hits `startSession()`.

OIDC has OIDC-specific hardcodes (PKCE state cookies, `discovery_cache`
JSONB, `oidc_end_session_url` / `oidc_id_token` / `oidc_client_id` columns
on `sessions`). A fully-generic refactor would be a multi-month project that
ships zero new functionality.

## Decision

We will add SAML and LDAP as **sibling provider packages** alongside OIDC, not
through a unified protocol abstraction:

- `lib/auth/providers/oidc.ts` stays. `lib/auth/providers/saml.ts` and
  `lib/auth/providers/ldap.ts` land in PR 2 and PR 3 of the
  `feat/auth-providers-ldap-saml-webauthn` branch.
- Each protocol gets its own DB table (`oidc_providers`, `saml_providers`,
  `ldap_providers`), its own admin UI list, its own validators. The schemas
  are protocol-specific (LDAP has bind DN + search filters; SAML has
  metadata XML + SP cert; OIDC has issuer + client id). Forcing them into
  one table buys nothing.
- All three converge on the SAME pair of types at the seam: `VerifiedIdentity`
  (the return shape of "an identity has been authenticated") and the call
  to `startSession({ userId, ip, userAgent, oidc?: {...} })`. SAML/LDAP add
  protocol-specific logout material via a new optional field on
  `VerifiedIdentity` rather than parallel named columns on `sessions`.

## Rationale

- **Each protocol is large enough to warrant its own surface.** A SAML
  provider config has fields that have no analogue in LDAP or OIDC (SP
  signing cert, metadata URL, signed-request requirement). An LDAP config
  has fields neither of the others have (bind DN, search base, group filter).
  Sharing a schema produces a JSONB-soup or nullable-column-soup with the
  same per-protocol validators we'd write anyway.
- **OIDC is shipping fine.** Refactoring it to fit a unified abstraction
  before we know what SAML and LDAP actually need is the inversion of
  "land the simplest thing that works."
- **The convergence point already exists.** `VerifiedIdentity` +
  `startSession()` is exactly the seam. SAML's verify-assertion path
  produces a `VerifiedIdentity`; LDAP's bind+search path produces one.
  Group → role materialisation via `applyGroupSync()` is already
  provider-agnostic - it works against any `provider.groupMappings`
  list and tags assignments with `provider_id`.
- **Logout material is heterogeneous and small.** Rather than rename
  `oidc_end_session_url` etc. to a generic JSONB now, extend
  `VerifiedIdentity` with an optional `providerLogoutMeta?: unknown` field
  that the session layer can stash per-protocol. SAML stores
  `saml_session_index`; LDAP stores nothing. The migration to a fully
  generic shape can happen later if the heterogeneity bites - today it
  doesn't.

## Alternatives considered

- **Unified `auth_providers` table with `type` discriminator + JSONB config.**
  Loses type safety on the config column, forces every read site to switch
  on type, makes admin UI validators stringly-typed at the boundary. The
  cost outweighs the appeal of "one CRUD UI."
- **Adapt OIDC's existing schema to be polymorphic.** Same downsides as
  above plus a forced refactor of a working surface.
- **Skip SAML/LDAP, double down on OIDC + Authentik LDAP-outpost.** Real
  customers run AD without Authentik. Doesn't address the actual need.

## Consequences

- PR 2 (LDAP) and PR 3 (SAML) each ship their own table + admin UI + plumbing
  module. Roughly the same code volume as `oidc-providers.ts` for each.
- WebAuthn sits **above** this layer - it's not an identity provider; it's
  a credential / second factor. ADR-0019 covers its design.
- A future "one admin page that lists all configured providers regardless
  of type" is a UI overlay over three list pages; the underlying tables
  stay separate.
- If a fourth protocol lands (e.g. WebFinger), the same pattern applies:
  new table, new admin UI, returns `VerifiedIdentity`.

## References

- `lib/auth/providers/types.ts` - `VerifiedIdentity` interface.
- `lib/auth/providers/oidc.ts` - current OIDC concretion.
- ADR-0019 (WebAuthn), ADR-0020 (LDAP), ADR-0021 (SAML).
