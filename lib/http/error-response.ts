/**
 * lib/http/error-response.ts
 *
 * The single mapping point from a thrown value to an HTTP `Response` for route
 * handlers. Replaces the ~37 per-route `errorResponse` copies that had drifted
 * apart (only some logged 5xx, only some mapped `PdnsError`).
 *
 * Mapping:
 *   • AppError (lib/errors.ts) → its `.status` + `.message` (+ `.details` for
 *     ValidationError / ConflictError). RateLimitedError also sets `Retry-After`.
 *   • PdnsError (lib/pdns/errors.ts) → 502 with a generic message. The detailed
 *     (already-redacted) PDNS message is logged at warn, never returned — it can
 *     carry upstream specifics we don't surface to API clients. This matches the
 *     behavior the PDNS-touching routes already had and fixes the others, which
 *     used to collapse a PdnsError to a generic 500.
 *   • Anything else → 500 "Internal error."; the original is logged via the
 *     cause `toAppError` captures.
 *
 * Every 5xx is logged server-side under `context` (used as the log event name),
 * so an internal error is never silent — the copies that skipped the log
 * produced invisible 500s.
 *
 * `context` is a stable dotted tag identifying the route + operation, e.g.
 * "admin.users.route.error". Defaults to a generic tag for callers that don't
 * pass one.
 */

import "server-only";
import { RateLimitedError, toAppError } from "@/lib/errors";
import { PdnsError } from "@/lib/pdns/errors";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";

export function errorResponse(err: unknown, context = "api.route.error"): Response {
  // PDNS upstream failures collapse to a generic 502: the detailed message can
  // carry backend specifics, so log (redacted) and return an opaque error.
  if (err instanceof PdnsError) {
    logger.warn({ err: redact(err.message), status: err.status }, context);
    return Response.json({ error: "PDNS rejected the request." }, { status: 502 });
  }

  const appErr = toAppError(err);

  // Rate-limit: clients read `retryAfterSeconds` from the body (see the login /
  // change-password / change-email forms); also send the standard header.
  if (appErr instanceof RateLimitedError) {
    return Response.json(
      { error: appErr.message, retryAfterSeconds: appErr.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(appErr.retryAfterSeconds) } },
    );
  }

  if (appErr.status >= 500) {
    const cause = appErr.cause ?? appErr;
    const causeMessage =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";
    logger.error({ err: redact(causeMessage) }, context);
    return Response.json({ error: "Internal error." }, { status: 500 });
  }

  const body: { error: string; details?: Record<string, unknown> } = { error: appErr.message };
  if (appErr.details !== undefined) body.details = appErr.details;
  return Response.json(body, { status: appErr.status });
}
