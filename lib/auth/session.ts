/**
 * lib/auth/session.ts
 *
 * Server-side session lifecycle. The cookie we set on the client carries the
 * *encrypted* session id; this module is the only place that encrypts /
 * decrypts that value.
 *
 * Cookie attributes:
 *   - HttpOnly: not readable from JS.
 *   - Secure: set in production (we send the cookie only over HTTPS).
 *   - SameSite=Lax: blocks most CSRF without breaking top-level navigations
 *     (the OIDC callback flow needs the cookie to survive a cross-site
 *     redirect, which Lax allows).
 *   - Path=/: cookie applies to the whole app.
 *   - Domain: set when COOKIE_DOMAIN is configured (multi-subdomain SSO).
 */

import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { cookieDomain, env, isProduction } from "@/lib/env";
import { decrypt, encrypt } from "@/lib/crypto/encryption";
import {
  createSession,
  findValidSessionById,
  revokeSession,
  touchSession,
} from "@/lib/db/repositories/sessions";
import type { Session } from "@/lib/db/schema";

export const SESSION_COOKIE = "pda_session";
export const CSRF_COOKIE = "pda_csrf";

/**
 * Create a new session row in the DB, encrypt its id into the session
 * cookie, and set the CSRF cookie. Call this from the local-auth and OIDC
 * callback paths after the identity is verified.
 */
export async function startSession(input: {
  userId: string;
  ip: string | null;
  userAgent: string | null;
  /**
   * OIDC RP-initiated-logout payload — captured by the callback
   * handler when the IdP advertised `end_session_endpoint` at
   * discovery. Logout reads these to build the post-logout redirect.
   * Optional / null for local sessions.
   */
  oidc?: {
    endSessionUrl: string | null;
    idToken: string | null;
    clientId: string | null;
    /**
     * Encrypted refresh token (caller encrypts via
     * `lib/crypto/encryption.ts`; the column stores ciphertext). Used
     * by the token-auth path to re-fetch groups at API token use time
     * — the basis for the "tokens follow real permissions" model in
     * #85. Null when the IdP didn't issue a refresh token.
     */
    refreshTokenEncrypted?: string | null;
  };
  /**
   * Permissions derived from the user's IdP groups at sign-in. The
   * compute path lives in `lib/auth/providers/group-sync.ts`
   * (`computeGroupSync`) — pure, returns this array. Empty for local
   * sessions and IdP sessions with no configured group mappings.
   * Persisted into `sessions.derived_permissions`; the ability builder
   * folds them into the user's effective permission set per request.
   */
  derivedPermissions?: Array<{
    permissions: readonly string[];
    scopeType: "global" | "team" | "zone" | "server";
    scopeId: string | null;
  }>;
}): Promise<Session> {
  // Session-fixation defense (S-10): if the caller already had a valid
  // session cookie (e.g. an anonymous-but-tracked state, or a user
  // re-authenticating into a different account from the same browser), kill
  // the existing session row before minting a new one. The cookie is then
  // unconditionally overwritten below — no stale id can survive a login.
  const cookieStore = await cookies();
  const existingCookie = cookieStore.get(SESSION_COOKIE)?.value;
  if (existingCookie) {
    try {
      const existingId = decrypt(existingCookie, "session-cookie");
      await revokeSession(existingId);
    } catch {
      // Bad / unknown-version cookie — nothing to revoke; the overwrite
      // below replaces it regardless.
    }
  }

  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
  const csrfSecret = randomBytes(32).toString("base64url");

  const session = await createSession({
    id: randomUUID(),
    userId: input.userId,
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent,
    csrfSecret,
    oidcEndSessionUrl: input.oidc?.endSessionUrl ?? null,
    oidcIdToken: input.oidc?.idToken ?? null,
    oidcClientId: input.oidc?.clientId ?? null,
    oidcRefreshTokenEncrypted: input.oidc?.refreshTokenEncrypted ?? null,
    derivedPermissions: input.derivedPermissions ?? [],
  });

  // Encrypted opaque cookie holding the session id.
  cookieStore.set(SESSION_COOKIE, encrypt(session.id, "session-cookie"), {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    domain: cookieDomain,
    expires: expiresAt,
  });

  // CSRF half — non-encrypted, readable by JS so the SPA layer can copy it
  // into a header on state-changing requests. The pairing happens in
  // `lib/auth/csrf.ts`.
  cookieStore.set(CSRF_COOKIE, csrfSecret, {
    httpOnly: false,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    domain: cookieDomain,
    expires: expiresAt,
  });

  return session;
}

/**
 * Read the session cookie, decrypt it, validate the session row, and bump
 * `lastSeenAt`. Returns the live row or null. Called by `getCurrentUser()`.
 */
export async function readSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (!cookieValue) return null;

  let sessionId: string;
  try {
    sessionId = decrypt(cookieValue, "session-cookie");
  } catch {
    // Tampered / unknown-version cookie. Drop it.
    return null;
  }

  const session = await findValidSessionById(sessionId);
  if (!session) return null;

  // Fire-and-forget the lastSeenAt update. We don't await it on the read path
  // so request latency isn't held hostage by an UPDATE.
  void touchSession(session.id);

  return session;
}

/**
 * Revoke the current session row and clear cookies. Idempotent — safe to
 * call even when no session exists.
 */
export async function endSession(): Promise<void> {
  const cookieStore = await cookies();
  const cookieValue = cookieStore.get(SESSION_COOKIE)?.value;
  if (cookieValue) {
    try {
      const id = decrypt(cookieValue, "session-cookie");
      await revokeSession(id);
    } catch {
      // Bad cookie — still clear it client-side below.
    }
  }
  cookieStore.delete(SESSION_COOKIE);
  cookieStore.delete(CSRF_COOKIE);
}
