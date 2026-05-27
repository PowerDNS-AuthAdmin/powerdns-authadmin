# ADR-0021: SAML 2.0 service-provider architecture

- **Status:** Accepted
- **Date:** 2026-05-28

## Context

OIDC covers most modern IdPs but operators with AD FS, legacy Shibboleth
deployments, or enterprise-mandated SAML federations still need a second
sign-in protocol. SAML 2.0 is the mature, widely-deployed standard there.

## Decision

Add SAML 2.0 SP support as a sibling of OIDC. Implementation is structurally
parallel — same admin admin UX (unified Authentication page), same group →
role mapping (the materialiser is protocol-agnostic), same cross-type slug
uniqueness via `auth_provider_slugs`.

### Library

[`@node-saml/node-saml`](https://github.com/node-saml/node-saml) at v5.1.0.
MIT-licensed, actively maintained, used by Passport's SAML strategy. CVE-2025
fixes in 5.1.0. xml-crypto v6.1.2 transitive dep covers the XML-DSig
verification (no direct dependency from our code).

### Schema

`saml_providers` mirrors `oidc_providers`: slug + name + IdP material
(entityID, SSO URL, SLO URL, signing cert) + SP material (signing keypair,
optional encryption keypair) + claim attribute names + same `allowedEmailDomains`

- `groupMappings` JSON columns.

Slug is reserved in `auth_provider_slugs(provider_type='saml')` at create
time — same transactional pattern OIDC uses. The cross-type PK constraint
prevents an SP and an OP from sharing a slug.

### Routes

- `GET  /api/auth/saml/<slug>/login` — builds AuthnRequest + redirects.
- `POST /api/auth/saml/<slug>/acs` — Assertion Consumer Service.
- `GET  /api/auth/saml/<slug>/metadata` — SP metadata XML.
- `GET  /api/auth/saml/<slug>/slo` — SP-initiated single logout.

The RequestID is stashed in a 10-minute HttpOnly cookie (`pda_saml_state`)
so the ACS can verify the inbound Response's `InResponseTo`.

### Secure defaults

- `wantAssertionsSigned: true` — non-negotiable.
- `wantAuthnResponseSigned: true` — operator can relax per-provider.
- `signatureAlgorithm: "sha256"` — `sha1` left selectable for legacy IdPs.
- `validateInResponseTo: always` — replay defense.
- The SP signing keypair is mandatory; encryption keypair is opt-in.

### Session storage

SAML logout material (IdP SLO URL + NameID + sessionIndex) is stashed in the
session row's existing `oidc_*` columns rather than adding a parallel set:
`oidc_end_session_url` ⇒ IdP SLO URL, `oidc_id_token` ⇒ NameID,
`oidc_client_id` ⇒ sessionIndex. The logout handler reads these to build a
SAML LogoutRequest. Keeps the schema flat at the cost of slightly
misleading column names; documented in
[`lib/auth/providers/saml.ts`](../../lib/auth/providers/saml.ts).

### Group → role mapping

The same `applyGroupSync` function is reused — it takes a provider id +
mappings array, doesn't care whether the provider is OIDC or SAML.

## Consequences

- One more protocol to maintain in lockstep with OIDC's evolutions. The
  parallel structure (form, route, repository, validator) keeps drift cheap
  to spot.
- The SP signing keypair is operator-managed (paste PEMs). Auto-generation
  was considered but rejected to stay clear of the `node:crypto` X.509
  builder limitations and to keep the SP cert in the operator's CA story.
- Session-row column repurposing is a small wart; it would only matter if a
  future change wanted to support a session minted concurrently by SAML +
  OIDC, which isn't a realistic scenario.
