# ADR 0021 — SAML 2.0 SP: signed assertions required by default, per-provider SP cert

- **Status:** Proposed — implementation lands in PR 3 of `feat/auth-providers-ldap-saml-webauthn`.
- **Date:** 2026-05-28
- **Deciders:** @jad-seifeddine

## Context

SAML 2.0 SSO is the lingua franca for enterprise IdPs that don't expose
OIDC — most notably AD FS on Windows Server 2019/2022 and Authentik /
Keycloak SAML applications running alongside an OIDC realm. The threat
landscape is non-trivial:

- **CVE-2025-54369** (xml-crypto, fixed in `@node-saml/xml-crypto@6.1.2`)
  let an attacker bypass SAML signature verification.
- **CVE-2025-47949** (samlify) — XML signature wrapping; CVSS 9.9.
- **CVE-2026-2092** (Keycloak) — encrypted-assertion binding gap.

Library shortlist (settled):

- `@node-saml/node-saml@^5.1.0` (MIT, ~590k weekly DLs, fixed CVE-2025-54369,
  `@types/node-saml@^4`). The maintained fork of `passport-saml`'s core.
- Pass on `samlify` — recent signature-wrapping CVE plus user-supplied
  XSD validator footgun.

## Decision

We will ship SAML SP support in PR 3 with:

- **Signed AuthnRequest mandatory.** Per-provider SP signing key generated
  at provider-create time (encrypted at rest with `APP_ENCRYPTION_KEY`).
  SP metadata exported at `GET /api/auth/saml/<slug>/metadata` for IdP-side
  registration.
- **Signed Response required by default.** `SAML_ALLOW_UNSIGNED_RESPONSE=true`
  env opt-out for lab environments. Both Response signing and Assertion
  signing supported; either satisfies the verifier when configured.
- **Encrypted assertions supported, not required.** Per-provider toggle
  `require_encrypted_assertion`. SP encryption key managed alongside
  the signing key.
- **Per-provider config row** in a new `saml_providers` table. Fields:
  `slug`, `name`, `idp_entity_id`, `idp_sso_url`, `idp_slo_url`,
  `idp_signing_cert` (PEM), `sp_signing_key_encrypted`, `sp_signing_cert`,
  `sp_encryption_key_encrypted` (optional), `sp_encryption_cert` (optional),
  `require_signed_response` (default true), `require_encrypted_assertion`
  (default false), `signature_algorithm` (default `rsa-sha256`),
  `name_id_format`, `claim_email`, `claim_name`, `claim_groups`,
  `enabled`, `force_default`, `allowed_email_domains`, `group_mappings`,
  `created_by`, `created_at`, `updated_at`.
- **Routes**:
  - `GET /api/auth/saml/<slug>/login` — generates a signed AuthnRequest,
    redirects to `idp_sso_url`.
  - `POST /api/auth/saml/<slug>/acs` — assertion consumer service.
    Verifies signature(s), decrypts assertion (if encrypted), extracts
    claims into `VerifiedIdentity`.
  - `GET /api/auth/saml/<slug>/metadata` — exports SP metadata XML.
  - `GET /api/auth/saml/<slug>/slo` — single-logout endpoint; sets the
    same `pda_just_logged_out` cookie as OIDC.
- **`saml_session_index` stashed on `sessions`** (or on the new
  generic `provider_logout_meta` JSONB if we land ADR-0018's deferred
  refactor) so RP-initiated logout can reference the IdP's session.
- **Worked doc examples** for AD FS on Windows Server 2019/2022/2025,
  Authentik SAML, Keycloak SAML.

## Rationale

- **Mandatory SP-signed AuthnRequest** prevents IdP misuse: every request
  the IdP receives is provably from this SP.
- **Default-on Response signing** closes the signature-wrapping class of
  bug at the verifier level. The env opt-out is loud and audit-logged.
- **Per-provider SP cert** rather than a single SP-wide cert means
  rotating one provider's trust relationship doesn't touch the others.
- **`@node-saml/node-saml` is the only viable library** post-CVE landscape
  cleanup. Its `samlp` predecessor is unmaintained; `samlify`'s recent
  CVE history is disqualifying.

## Alternatives considered

- **One SP-wide signing key.** Simpler but couples every IdP's trust
  relationship; rotating one means re-uploading SP metadata to all of them.
- **Allow unsigned responses by default.** No — the threat model includes
  hostile IdPs and signature-wrapping attacks. Loud opt-in required.
- **`samlify` for the wider feature set.** Recent CVE + user-supplied XSD
  validator = no.
- **Roll our own SAML.** No.

## Consequences

- New table + Drizzle migration in both dialects.
- Per-provider keypair generation at create time. Worth shipping a
  one-shot "regenerate SP keypair" admin action for incident response.
- Integration tests need a SAML IdP — added to the existing test-stack
  Keycloak with a SAML realm alongside its OIDC realm.
- AD FS interop requires the exported SP metadata: doc'd in
  `docs/13-SAML.md` with the import flow.
- SLO is best-effort; the just-logged-out cookie + the local fallback
  cover SAML the same way they do OIDC.

## References

- `@node-saml/node-saml`:
  https://github.com/node-saml/node-saml
- CVE-2025-54369 advisory:
  https://github.com/advisories/GHSA-m837-g268-mmv7
- CVE-2025-47949 advisory (samlify):
  https://github.com/advisories/GHSA-r683-v43c-6xqv
- AD FS SAML interop:
  https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/operations/improved-interoperability-with-saml-2.0
- ADR-0018 (multi-provider architecture).
