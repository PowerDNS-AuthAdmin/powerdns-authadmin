# ADR 0020 — LDAP: TLS-strict by default, bind-then-search, group sync via `applyGroupSync`

- **Status:** Proposed — implementation lands in PR 2 of `feat/auth-providers-ldap-saml-webauthn`.
- **Date:** 2026-05-28
- **Deciders:** @jad-seifeddine

## Context

Direct LDAP bind is the realistic deployment shape for organisations on
Microsoft Active Directory (Windows Server 2019/2022/2025) or OpenLDAP
that aren't yet behind an OIDC/SAML facade. Sequential constraints:

- AD DS post-KB4520412 expects LDAP signing and/or LDAPS channel binding;
  unsigned LDAP on port 389 is increasingly refused.
- OpenLDAP 2.6 lives in `cn=config`; legacy `slapd.conf` deployments need
  StartTLS hand-rolled.
- The Node landscape narrowed to one viable option: `ldapts@^8.1.8`
  (TS-first, ESM, dual exports, Node ≥20). `ldapjs` was archived
  in May 2024.

## Decision

We will ship LDAP support in PR 2 with:

- **Strict TLS by default.** Only `ldaps://` URIs accepted, OR `ldap://`
  - an explicit `start_tls: true` flag on the provider row. Plain
    unencrypted LDAP on port 389 requires `LDAP_ALLOW_INSECURE_PORT_389=true`
    in env (mirrors the `APP_PDNS_ALLOW_INSECURE_HTTP` pattern). The validator
    refuses unencrypted URIs at provider-create time when that env is unset.
- **`rejectUnauthorized: true` by default** for TLS sockets. Allow CA pinning
  via a per-provider `tls_ca_cert` field (PEM string, encrypted at rest).
  `LDAP_TLS_INSECURE_SKIP_VERIFY=true` env opt-out for lab environments.
- **Bind-then-search flow.** Service-account bind → search the user DN by
  filter → re-bind with the user's password. Group memberships extracted
  via `memberOf` (AD default) or a configurable group-search filter
  (OpenLDAP). Maps to `applyGroupSync()` exactly like OIDC group claims —
  same `provider_id`-tagged `role_assignments` rows.
- **Per-provider config row** in a new `ldap_providers` table. Fields:
  `slug`, `name`, `server_url`, `start_tls`, `bind_dn`,
  `bind_password_encrypted`, `user_search_base`, `user_search_filter`
  (defaults to `(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))`),
  `group_search_base`, `group_search_filter`, `group_attr`
  (defaults to `memberOf`), `tls_ca_cert`, `enabled`, `force_default`,
  `allowed_email_domains`, `group_mappings`, `created_by`,
  `created_at`, `updated_at`.
- **New route**: `POST /api/auth/ldap/<slug>/login` (body: `{username, password}`).
  The login form gets a third sign-in tab when an LDAP provider is enabled.
- **Worked doc examples** for Active Directory (KB4520412 channel binding /
  signing requirements, `serverctl` cipher hardening) and OpenLDAP 2.6
  (`olcTLSCipherSuite` in `cn=config`).

## Rationale

- **TLS-strict default matches the broader pattern** (`APP_PDNS_*` ssrf
  guards, `WEBAUTHN_ALLOW_INSECURE_ORIGINS`). The opt-out is loud and
  loggable.
- **Bind-then-search avoids storing user passwords or DN prefixes**. A
  service account with read-only directory access is the standard ops
  pattern for both AD and OpenLDAP.
- **`memberOf` is the AD default** and works for the vast majority of
  OpenLDAP deployments after the `memberof` overlay is loaded. The
  group-search-filter escape hatch covers the rest.
- **`applyGroupSync` is provider-agnostic.** Same code path that OIDC
  uses; no new materialisation logic.

## Alternatives considered

- **`ldapjs`.** Archived; not viable.
- **Pre-LDAPS-only, no `start_tls` support.** Some operators run AD with
  StartTLS on 389 (especially in environments with internal CAs). Worth
  supporting alongside LDAPS.
- **Direct user-DN bind (no service account).** Forces operators to
  expose a DN-template; works only for flat directory layouts. The
  bind-then-search pattern subsumes it.

## Consequences

- New table + Drizzle migration in both dialects.
- Login form gains a third tab. The MFA gate composes with LDAP the
  same way it does with OIDC + local — LDAP users with `requires_mfa`
  roles still go through the WebAuthn / TOTP second-factor step.
- Integration tests need a real OpenLDAP container — added to
  `tests/integration/docker-compose.test.yml` in PR 2.
- Logout for LDAP is trivial: no IdP session to terminate. The standard
  local-fallback path applies.

## References

- `ldapts` docs: https://github.com/ldapts/ldapts
- MS KB4520412 (LDAP channel binding/signing):
  https://support.microsoft.com/en-us/topic/2020-2023-and-2024-ldap-channel-binding-and-ldap-signing-requirements-for-windows-kb4520412-ef185fb8-00f7-167d-744c-f299a66fc00a
- OpenLDAP 2.6 TLS: https://www.openldap.org/doc/admin26/tls.html
- ADR-0018 (multi-provider architecture).
