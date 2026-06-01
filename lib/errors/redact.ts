/**
 * lib/errors/redact.ts
 *
 * Defense-in-depth secret scrubbing for strings about to be logged or surfaced in
 * error messages. The Pino logger already does field-level redaction (see
 * `lib/logger.ts`) - this module catches the cases Pino can't: secrets that end
 * up *inside* a free-form string ("connection failed: postgres://user:hunter2@...").
 *
 * Add a pattern here whenever you encounter a new shape of secret in logs. Better
 * to over-redact than under-redact.
 */

import "server-only";

/**
 * Replace anything that looks like a credential in `input` with the literal token
 * `[Redacted]`. Idempotent and safe for any string input including `undefined`-cast.
 *
 * @example
 *   redact("postgres://user:hunter2@host/db") → "postgres://user:[Redacted]@host/db"
 *   redact("Bearer abc.def.ghi") → "Bearer [Redacted]"
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;

  // URL-embedded passwords: `scheme://user:password@host`
  out = out.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s]+):[^@\s]+@/gi, "$1:[Redacted]@");

  // Bearer / X-API-Key / Basic auth tokens
  out = out.replace(/\b(Bearer|Basic)\s+[\w._\-+/=]+/gi, "$1 [Redacted]");
  out = out.replace(/\b(X-API-Key:\s*)[\w._\-+/=]+/gi, "$1[Redacted]");

  // PEM-style block contents (private keys, certificates with embedded keys)
  out = out.replace(
    /-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g,
    "[Redacted PEM block]",
  );

  // GitHub-style PAT prefixes (pda_pat_, github_pat_, ghp_, gho_, etc.) - pad to
  // 8+ chars so we don't accidentally redact "pat_" mentions in prose.
  out = out.replace(/\b(pda_pat_|github_pat_|gh[pousr]_)[A-Za-z0-9_]{8,}/g, "$1[Redacted]");

  // JWT shape (three base64url segments separated by dots, last segment ≥ 16 chars)
  out = out.replace(
    /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/g,
    "[Redacted JWT]",
  );

  return out;
}

/**
 * Build a stable error message safe for logs and 5xx response bodies. Wraps `redact`
 * with a short cause chain.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return redact(err.message);
  return redact(String(err));
}
