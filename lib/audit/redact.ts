/**
 * lib/audit/redact.ts
 *
 * Pure secret-scrubber for audit `before` / `after` snapshots. Lives
 * in its own module so unit tests can exercise it without dragging in
 * `lib/db` (which transitively imports `pg`, making `vitest` choke
 * loading the module under the worker environment).
 *
 * Add a field name here whenever the app surfaces a new secret-shaped
 * value through audit snapshots. Over-redacting an audit row's label
 * is cheap; ever logging a secret is not.
 */

/** Field names whose values we never want to persist in `before`/`after`. */
export const REDACT_FIELDS: ReadonlySet<string> = new Set([
  "password",
  "password_hash",
  "passwordHash",
  "token",
  "token_hash",
  "tokenHash",
  "secret",
  "client_secret",
  "clientSecret",
  "apiKey",
  "api_key",
  "encryption_key",
  "encryptionKey",
  "privateKey",
  "private_key",
  "totp_secret_encrypted",
  "totpSecretEncrypted",
  "csrf_secret",
  "csrfSecret",
  "webauthn_credentials",
  "webauthnCredentials",
  // PDNS TSIG keys carry the base64-encoded HMAC secret under the
  // top-level field `key`. Bare `key` is generic enough that it could
  // collide with non-sensitive uses elsewhere — but the cost of
  // over-redacting an audit row's UI label is dramatically lower than
  // ever logging a shared-secret HMAC key.
  "key",
]);

export const REDACTED = "[Redacted]";

/**
 * Walk a JSON-able object and replace values of known-secret-named fields
 * with `[Redacted]`. Recursive but bounded: stops at `MAX_DEPTH` to avoid
 * runaway on cyclic structures. Returns a fresh object — does not mutate.
 */
export function redactSnapshot(value: unknown, depth = 0): unknown {
  const MAX_DEPTH = 12;
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSnapshot(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_FIELDS.has(k)) {
      out[k] = REDACTED;
    } else {
      out[k] = redactSnapshot(v, depth + 1);
    }
  }
  return out;
}
