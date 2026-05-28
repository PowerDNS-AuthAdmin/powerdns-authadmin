# ADR 0019 — WebAuthn: both primary credential and second factor

- **Status:** Accepted
- **Date:** 2026-05-28
- **Deciders:** @jad-seifeddine

## Context

The app shipped with TOTP-only MFA. WebAuthn (`users.webauthn_credentials`
JSONB column with a schema that already matches `@simplewebauthn/server`'s
shape) was scaffolded but never wired. Modern auth UX expects passkeys —
both as a passwordless primary credential and as a strong second factor.

Library landscape (mid-2026):

- `@simplewebauthn/server@^13.3.1` — MIT, first-party TS types, no native
  deps (uses `cbor-x` vendored), Node ≥20, ESM. De-facto standard.
- `@simplewebauthn/browser@^13` — pairs with the server package, used
  to drive `navigator.credentials.create()` / `get()` from the SPA.

WebAuthn binds to a Relying-Party identifier (`rpId`, a bare hostname) and
an `origin` (scheme+host+port). Both must match the URL the operator's
browser uses — same constraint as the cookie-domain issue this branch
already fixed in the previous PR.

## Decision

We will implement WebAuthn as **both** a primary credential (passwordless
sign-in via discoverable credentials) and a second factor (alongside TOTP).
A user can have zero, one, or many credentials enrolled; each is named by
the user and removed individually.

Defaults:

- `WEBAUTHN_RP_ID` derived from `APP_URL` hostname. Override only for apex-
  domain credential sharing across sub-domains (rare).
- `WEBAUTHN_USER_VERIFICATION = "preferred"`. Required for high-security
  deployments; never disabled.
- `WEBAUTHN_ATTESTATION = "none"`. Privacy-preserving default; `direct` for
  audit-grade deployments wanting attestation statements.
- `WEBAUTHN_ALLOW_INSECURE_ORIGINS = false`. LAN-dev opt-in.

MFA-compliance becomes `totpEnrolled || webauthnEnrolled`. The forced-MFA
gate (per-role `requires_mfa`, per-user `mfaRequired=true`) is satisfied
by EITHER method.

## Rationale

- **The schema is already in place** (`users.webauthn_credentials` JSONB
  array). No migration, no DB design choices to second-guess.
- **One credential type, two ceremonies.** Registration and assertion are
  the only two flows; both `@simplewebauthn/server` and `@simplewebauthn/
browser` handle them. The complexity is bounded.
- **Per-credential management** is the right granularity. A user with
  three passkeys (Mac, iPhone, YubiKey) can drop the lost iPhone one
  without re-enrolling the others. Mirrors how Google / Apple / GitHub
  do it.
- **Both primary AND second factor** is what operators actually want. The
  passkey-first UX (no password) is the long-term direction; the second-
  factor path is the bridge for users who haven't enrolled yet.
- **Challenge state piggybacks on the existing `temp-reveal-store`.** Same
  single-use, actor-bound, 5-minute TTL semantics that TOTP enrolment uses.
  No new short-lived storage primitive.

## Alternatives considered

- **Second-factor only.** Simpler — same flow as TOTP. But it leaves
  passkey-first UX (which is the actual long-term win) for a follow-up.
  Given the schema is already there, doing both at once is cheap.
- **Primary only.** Forces an immediate UX rewrite for the password flow;
  doesn't help existing TOTP-enrolled users until they re-enrol.
- **fido2-lib instead of @simplewebauthn.** Pre-passkey-era, doesn't
  expose discoverable credentials cleanly.

## Consequences

- `MfaPanel` admin component renames in spirit — the per-credential reset
  is by credential id, not blanket "reset MFA". TOTP admin reset stays
  blanket.
- The login form has two states beyond happy-path: a passkey-primary
  button and a second-factor switcher (TOTP / passkey) when both are
  enrolled.
- `lib/auth/mfa-compliance.ts` `UserMfaState` gains a `webauthnEnrolled`
  field; every caller (layout, `requireUserForPage`,
  `session-compliance`) computes it as `user.webauthnCredentials.length > 0`.
- New audit-vocabulary entries: `auth.mfa.webauthn.enrolled`,
  `auth.mfa.webauthn.removed`, `auth.mfa.webauthn.renamed`.
- `WEBAUTHN_RP_ID` is critical for behind-proxy deployments. Documented
  in `docs/11-PASSKEYS.md` next to the existing `X-Forwarded-Host`
  guidance.

## References

- `lib/auth/webauthn/{config,registration,assertion,index}.ts`.
- `lib/db/repositories/webauthn.ts`.
- W3C WebAuthn Level 3: https://www.w3.org/TR/webauthn-3/
- SimpleWebAuthn docs: https://simplewebauthn.dev/docs/packages/server
