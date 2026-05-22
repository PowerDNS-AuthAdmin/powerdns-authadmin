/**
 * lib/errors.ts
 *
 * Typed error hierarchy. Throwing one of these from anywhere in the app lets the
 * HTTP layer (`app/api/**` route handlers, server actions) map errors to status
 * codes in exactly one place — `httpStatusForError` below.
 *
 * Why a hierarchy: branching on string error messages is the kind of thing that
 * looks fine until your locale changes or a library updates its wording. Types
 * survive refactors; strings don't.
 *
 * Rules:
 *  • Every error has a `code` (machine-readable) and a `message` (human-readable).
 *  • Error `message` must never contain secrets. Pass values through
 *    `lib/errors/redact.ts` first if you're not sure.
 *  • Add new error subclasses here, not in feature folders. Local one-off errors
 *    bloat into a parallel hierarchy nobody can grep.
 */

/**
 * Base class for all application errors. Carries an HTTP-friendly `code` so the
 * API layer can return RFC 7807 problem responses without a switch statement.
 */
export class AppError extends Error {
  /** Stable machine-readable identifier (e.g. "ZONE_NOT_FOUND"). */
  public readonly code: string;
  /** HTTP status to use when this error reaches the response. */
  public readonly status: number;
  /** Optional structured details, surfaced in the problem response as `details`. */
  public readonly details?: Record<string, unknown>;

  public constructor(
    code: string,
    message: string,
    status: number,
    options?: { cause?: unknown; details?: Record<string, unknown> },
  ) {
    super(message, { cause: options?.cause });
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (options?.details !== undefined) this.details = options.details;
    // Maintain a clean stack trace pointing at the throw site (V8 only).
    if ("captureStackTrace" in Error) {
      (
        Error as unknown as {
          captureStackTrace: (target: object, ctor: new (...args: never[]) => unknown) => void;
        }
      ).captureStackTrace(this, this.constructor as unknown as new (...args: never[]) => unknown);
    }
  }
}

/** 400 — the request was malformed or failed validation. */
export class ValidationError extends AppError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_ERROR", message, 400, details ? { details } : undefined);
  }
}

/** 401 — the request is unauthenticated. Do not use for "logged in but lacks permission". */
export class UnauthorizedError extends AppError {
  public constructor(message = "Authentication required.") {
    super("UNAUTHORIZED", message, 401);
  }
}

/** 403 — the actor is authenticated but lacks permission for this resource/action. */
export class ForbiddenError extends AppError {
  public constructor(message = "You do not have permission to perform this action.") {
    super("FORBIDDEN", message, 403);
  }
}

/** 404 — the requested resource does not exist (or, for security, the actor cannot see it). */
export class NotFoundError extends AppError {
  public constructor(message = "Resource not found.") {
    super("NOT_FOUND", message, 404);
  }
}

/**
 * 409 — the request conflicts with current state. Used for optimistic-concurrency
 * failures (the zone changed since you started editing) and unique-constraint
 * collisions (an account with that email already exists).
 */
export class ConflictError extends AppError {
  public constructor(message: string, details?: Record<string, unknown>) {
    super("CONFLICT", message, 409, details ? { details } : undefined);
  }
}

/** 429 — rate-limited. The middleware sets `Retry-After`; this carries the value. */
export class RateLimitedError extends AppError {
  public readonly retryAfterSeconds: number;
  public constructor(retryAfterSeconds: number) {
    super("RATE_LIMITED", "Too many requests.", 429, {
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 502 — an upstream dependency (PowerDNS, OIDC IdP) is unreachable or returning errors. */
export class UpstreamError extends AppError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super("UPSTREAM_ERROR", message, 502, options);
  }
}

/**
 * 500 — an internal invariant was violated. These should never reach a user; if they
 * do, it's a bug. The HTTP layer redacts the message and logs the original.
 */
export class InternalError extends AppError {
  public constructor(message: string, options?: { cause?: unknown }) {
    super("INTERNAL_ERROR", message, 500, options);
  }
}

/**
 * Map any thrown value to an `AppError`. Unknown errors become `InternalError`
 * with their message redacted; this is what the HTTP layer calls to ensure no
 * raw exception ever reaches a user.
 */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    return new InternalError(
      // The original message is captured in `cause` for the log, not the response.
      "An unexpected error occurred.",
      { cause: err },
    );
  }
  return new InternalError("An unexpected error occurred.", { cause: err });
}

/**
 * Convenience for HTTP route handlers. Returns the status code an error should be
 * serialized with.
 */
export function httpStatusForError(err: unknown): number {
  return err instanceof AppError ? err.status : 500;
}
