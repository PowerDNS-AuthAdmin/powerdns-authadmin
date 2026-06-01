# ADR 0020 - LDAP authentication architecture

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** @jadseifeddine

## Context

A meaningful fraction of self-hosted DNS operators still run Active Directory or OpenLDAP as their
authoritative identity store. Forcing them through an OIDC bridge (Authentik, Keycloak, ADFS in
OIDC mode) is a real lift for a single-app deployment, and many of them simply turn on a separate
sign-in tool rather than introduce a federation tier they don't otherwise need. PR 2 of
`feat/auth-providers-ldap-saml-webauthn` therefore adds first-class LDAP support - direct bind
against the directory, no broker in the middle.

We've already got the heterogeneous-provider plumbing (`auth_provider_slugs` for cross-type
uniqueness, the unified `/admin/authentication` view, the `auth_default_provider` setting with
typed-prefix slugs). LDAP slots into that frame; this ADR records the LDAP-specific decisions.

## Decision

**Library.** Use `ldapts@^8.1.8` for all LDAP traffic. It's TypeScript-first, ESM, dual-exports,
maintained, and handles StartTLS / TLS pinning cleanly. We will NOT use `ldapjs` - its main
package is archived and the maintained forks haven't converged.

**Bind model.** Bind-then-search-then-rebind. The admin-configured service account binds first,
runs a search for the user by username under a configured base + filter, then we re-bind as the
returned user DN with the password the operator typed. This is the standard pattern for AD and
OpenLDAP alike - it keeps the user-search filter operator-controlled (so RFC 4515 escaping and
attribute-pinning don't get pushed to the user) and lets us use the SAME flow for both directory
flavors.

**TLS posture.** Strict by default. `ldaps://` is preferred. Plain `ldap://` on port 389 is
refused unless EITHER `LDAP_ALLOW_INSECURE_PORT_389=true` (env-level opt-in for the trusted-LAN
homelab case) OR `start_tls: true` on the provider row (RFC 4511 upgrade after connect). Self-
signed certs are refused unless `LDAP_TLS_INSECURE_SKIP_VERIFY=true` is loudly set; a PEM CA pin
on the provider row is the supported way to trust an internal CA without disabling verification
globally.

**Group resolution.** Two paths. Either the user record carries the group list as a
multi-valued attribute (AD's `memberOf`, fully resolved by the DC; this is the common case) OR
the operator configures a second search (`group_search_base` + `group_search_filter`) to
materialise the groups (OpenLDAP with the `memberof` overlay disabled, or `groupOfUniqueNames`
needing a `member={{userDn}}` filter). We always read `group_attr` from the user entry first; the
second search is the fallback. The materialised group set goes through the same
`applyGroupSync` from `lib/auth/providers/oidc-group-sync.ts` - that pure differ doesn't care
which protocol produced the groups, only that there's a set + a list of mappings.

**Filter substitution.** The `user_search_filter` contains a `{{username}}` placeholder. The
substituted value is LDAP-escaped (RFC 4515) before splicing - never the raw input. Same posture
as parameterised SQL.

**Secrets at rest.** Bind password + any CA cert PEM go through `lib/crypto/encryption.ts` (the
existing AES-256-GCM envelope; same usage tag is `ldap-bind-password`).

## Rationale

Bind-then-search is the only model that works for both AD and OpenLDAP without operator-side
contortions. The alternative - bind directly as `uid=<typed-username>,ou=Users,...` - works for
OpenLDAP-style directories but breaks the moment users live in nested OUs or the DN convention
isn't `uid=`. AD doesn't support `uid` binding at all; it wants the full DN or the userPrincipalName.
The two-bind flow handles every shape we've seen.

Strict TLS by default keeps an off-by-one operator from sending bind passwords in cleartext over
their LAN. The two opt-outs are deliberately loud - env-level for the homelab case,
`start_tls: true` for the upgraded-connection case - so a real-world deploy stays encrypted
without operator vigilance.

Reusing `applyGroupSync` is a small ergonomic win for operators: same mental model whether their
provider is OIDC or LDAP. The pure differ is provider-agnostic by design; only the source of the
group set differs.

## Alternatives considered

- **`ldapjs`.** The main package on npm is archived; the forks are uncoordinated. We don't want
  to inherit that maintenance question.
- **`passport-ldapauth`.** Pulls in passport itself, which we don't use anywhere else. The
  primitives `ldapts` exposes are exactly what we need.
- **Bind-only (no search).** Simpler code, but breaks for any directory where users live under
  varied DNs. Operator pain dwarfs the simplicity gain.
- **OIDC-only, push operators to Authentik/Keycloak.** Real-world DNS operators have an existing
  LDAP store and balk at running a federation broker for a single tool. Forcing them out is a
  loss.

## Consequences

- New table `ldap_providers` mirrors `oidc_providers`. Two migrations land
  (`drizzle/00NN_*.sql` for PG and the matching SQLite file).
- New route at `POST /api/auth/ldap/<slug>/login` - same captcha + rate-limit middleware as the
  local login route.
- `/admin/authentication/new` LDAP card flips from "Lands in PR 2" to live. The form lives in
  `app/(app)/admin/ldap-providers/_components/ldap-provider-form.tsx`; the edit page at
  `app/(app)/admin/ldap-providers/[id]/page.tsx`.
- New audit actions `ldap.provider.created` / `.updated` / `.deleted`; `auth.login.success` after-
  state now carries `method: "ldap"`.
- Provisioning gains an `ldap:` block (analog of `oidc:`). The `auth_default_provider` bare-slug
  resolver picks up LDAP slugs through the same `auth_provider_slugs` reservation handshake.
- Operator docs: `docs/12-LDAP.md` adds a worked AD example (KB4520412 channel binding,
  sAMAccountName + memberOf) and an OpenLDAP 2.6 example (`olcTLSCipherSuite` in `cn=config`,
  `memberof` overlay).

## References

- [ldapts on npm](https://www.npmjs.com/package/ldapts)
- [RFC 4515 - LDAP search filters](https://datatracker.ietf.org/doc/html/rfc4515)
- [RFC 4511 - LDAP protocol (StartTLS in §4.14)](https://datatracker.ietf.org/doc/html/rfc4511)
- ADR-0018 (separate per-protocol provider tables + a cross-type slug guard).
- ADR-0019 (`auth_default_provider` typed-prefix value semantics).
