/**
 * lib/pdns/errors.ts
 *
 * Typed error hierarchy for PowerDNS HTTP responses + transport failures.
 *
 * Why a parallel hierarchy to `lib/errors.ts`: client-facing app errors
 * carry HTTP status semantics for *our* API; PDNS errors carry semantics for
 * the upstream response. Conflating them loses information. Callers that
 * want to surface a PDNS failure as an app error wrap one in the other
 * deliberately (see `lib/pdns/client.ts`).
 *
 * Every error message has already been passed through `lib/errors/redact.ts`
 * before construction — the API key never appears in `.message`.
 */

import "server-only";

/** Base class. Carries the HTTP status (or 0 for transport errors). */
export class PdnsError extends Error {
  public readonly status: number;
  public readonly body?: unknown;

  public constructor(
    message: string,
    options: { status: number; body?: unknown; cause?: unknown },
  ) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.status = options.status;
    if (options.body !== undefined) this.body = options.body;
  }
}

/** 400 — PDNS rejected the request payload. */
export class PdnsValidationError extends PdnsError {}

/** 401/403 — wrong or missing API key. */
export class PdnsAuthError extends PdnsError {}

/** 404 — zone, RRset, or other resource not found. */
export class PdnsNotFoundError extends PdnsError {}

/** 409/412 — optimistic concurrency or precondition failure. */
export class PdnsConflictError extends PdnsError {}

/** 422 — unprocessable entity (PDNS-specific semantic error). */
export class PdnsUnprocessableError extends PdnsError {}

/**
 * 0 (transport) or 5xx (upstream). Treat as retryable up to the client's
 * `maxAttempts`. After retries exhaust, the caller sees this and converts to
 * an app-level UpstreamError if it bubbles to a route handler.
 */
export class PdnsUpstreamError extends PdnsError {}

/**
 * Map an HTTP status + parsed body to the right subclass. `body` is the raw
 * parsed JSON, kept around for the audit log and admin diagnostic UI.
 */
export function classifyPdnsHttpError(status: number, body: unknown, message: string): PdnsError {
  if (status === 0 || status >= 500) {
    return new PdnsUpstreamError(message, { status, body });
  }
  if (status === 400) return new PdnsValidationError(message, { status, body });
  if (status === 401 || status === 403) return new PdnsAuthError(message, { status, body });
  if (status === 404) return new PdnsNotFoundError(message, { status, body });
  if (status === 409 || status === 412) return new PdnsConflictError(message, { status, body });
  if (status === 422) return new PdnsUnprocessableError(message, { status, body });
  return new PdnsError(message, { status, body });
}
