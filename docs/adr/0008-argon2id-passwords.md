# ADR 0008 — Argon2id for password hashing

- **Status:** Accepted
- **Date:** 2026-05-16
- **Deciders:** @jseifeddine

## Context

bcrypt has been the safe default for password hashing for years and there are no known breaks of
it, but the field has moved on. OWASP's current Password Storage Cheat Sheet recommends Argon2id
as the primary password hashing function. We pick the recommended primary.

## Decision

Local-account password hashing uses **Argon2id** via the `argon2` npm package. Parameters track
OWASP's current recommendations and are reviewed yearly.

Initial parameters (OWASP Cheat Sheet 2024):

- **m_cost** (memory): `19456` (≈19 MiB)
- **t_cost** (iterations): `2`
- **parallelism**: `1`
- **hash length**: 32 bytes
- **salt length**: 16 bytes (generated per-hash by the library)

## Rationale

- **Memory-hard.** Argon2id requires significant RAM per attempt, making large-scale GPU /
  ASIC attacks much more expensive than bcrypt's CPU-bound work. This is the property that
  matters as commodity hardware gets faster.
- **OWASP's primary recommendation.** Aligning with OWASP gives us a defensible position in any
  security audit.
- **Hybrid mode.** Argon2id combines Argon2i (side-channel resistant) and Argon2d (GPU-resistant).
  Best of both.
- **Library quality.** The `argon2` npm package wraps the reference C implementation with
  reasonable defaults and active maintenance.

## Alternatives considered

- **bcrypt.** Still safe, but Argon2id has clearly surpassed it on the OWASP guidance.
- **scrypt.** Also memory-hard, also good. Rejected because Argon2id is the more recent design
  and has the OWASP endorsement.
- **PBKDF2.** Still common in regulated industries. Rejected — CPU-bound only, weaker against
  GPU attacks.

## Consequences

- **API tokens use the same hashing scheme.** A `pda_pat_...` token is stored as an Argon2id
  hash with the same parameters. Verification cost is the same as a password — acceptable
  because API token verification is rate-limited at the route layer.
- **Verify cost is non-trivial.** A typical verify takes 50–100ms on commodity hardware. Login
  endpoints absorb this without complaint. Bulk verification (e.g., importing users from another
  system) needs batching and a "this will take a while" UI.
- **Parameter rotation.** Every year, review OWASP. If we bump parameters, existing hashes
  remain valid; users get re-hashed on next successful login (the `argon2.needsRehash` helper).

## References

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [`argon2` npm package](https://www.npmjs.com/package/argon2)
- `lib/auth/password.ts` (the implementation)
