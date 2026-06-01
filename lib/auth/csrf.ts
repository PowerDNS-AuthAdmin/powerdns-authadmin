/**
 * lib/auth/csrf.ts
 *
 * Double-submit CSRF token verification.
 *
 * Model:
 *   1. On session start, a random `csrfSecret` is generated and stored on
 *      the session row.
 *   2. The secret is also sent to the client as a JS-readable cookie
 *      (`pda_csrf`). The client copies it into the `x-csrf-token` header on
 *      every state-changing request.
 *   3. On the server, we compare the header against the session's stored
 *      secret in constant time. Mismatch → 403.
 *
 * Why this rather than SameSite-only: SameSite=Lax is the first line of
 * defense, but for top-level navigation cases (a phishing link that POSTs
 * after a redirect) the cookie still rides along. Double-submit eliminates
 * that residual attack surface.
 *
 * Why double-submit rather than synchronizer tokens: simpler. Synchronizer
 * tokens need a server-side per-form value; double-submit just needs the
 * session row.
 *
 * Bearer-auth API requests are CSRF-exempt by construction: they don't carry
 * the session cookie, so an attacker on a third-party origin can't forge
 * them.
 */

import "server-only";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { ForbiddenError } from "@/lib/errors";
import { readSession, SESSION_COOKIE } from "./session";

/**
 * Verify a CSRF header against the session secret. Returns true on match.
 * Constant-time; do not short-circuit even if lengths differ.
 */
export function verifyCsrf(headerValue: string | null, sessionSecret: string): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(sessionSecret);
  if (a.length !== b.length) {
    // timingSafeEqual throws on length mismatch - pad to avoid the throw
    // while still failing the check.
    const max = Math.max(a.length, b.length);
    const padA = Buffer.concat([a, Buffer.alloc(max - a.length)]);
    const padB = Buffer.concat([b, Buffer.alloc(max - b.length)]);
    timingSafeEqual(padA, padB);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Methods that don't change state and therefore don't need CSRF protection.
 * Aligned with RFC 9110 § 9.2.1 - these are required to be safe.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Enforce double-submit CSRF on a mutating route handler. Call near the top
 * of every POST/PATCH/PUT/DELETE handler, after `requireUser()`.
 *
 * Skipped when:
 *   - the method is safe (GET/HEAD/OPTIONS) - no protection needed;
 *   - no session cookie is present - Bearer / X-API-Key auth is CSRF-exempt
 *     by construction (an attacker on a third-party origin cannot forge the
 *     token header).
 *
 * Throws `ForbiddenError` on mismatch, which the route handler maps to 403.
 */
export async function requireCsrf(request: Request): Promise<void> {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return;

  const cookieStore = await cookies();
  const sessionCookiePresent = cookieStore.get(SESSION_COOKIE)?.value;
  if (!sessionCookiePresent) return;

  const session = await readSession();
  if (!session) return;

  const headerToken = request.headers.get("x-csrf-token");
  if (!verifyCsrf(headerToken, session.csrfSecret)) {
    throw new ForbiddenError("CSRF token invalid or missing.");
  }
}
