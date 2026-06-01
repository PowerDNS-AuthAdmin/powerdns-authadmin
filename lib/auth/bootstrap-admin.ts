/**
 * lib/auth/bootstrap-admin.ts
 *
 * The `BOOTSTRAP_ADMIN_RO` identity lock. When enabled (intended for a public
 * demo whose login is published), the bootstrap admin account — the one whose
 * email matches `BOOTSTRAP_ADMIN_EMAIL` — is frozen against any change to its
 * own identity or credentials: password, email, name, MFA/passkey enrolment,
 * disable/delete, and role assignment. This stops a visitor signed in as the
 * shared admin from hijacking or locking the login out from under everyone else.
 *
 * The lock is keyed purely by email (case-insensitive) — no schema column — so
 * it composes with the existing email-keyed seed path (`scripts/seed.ts`) and
 * needs no migration. It is a no-op unless `BOOTSTRAP_ADMIN_RO=true`, so real
 * deployments are entirely unaffected.
 *
 * Enforcement lives at the API route handlers (the security boundary); the
 * matching UI affordances (disabled forms / actions) are a convenience layer
 * that calls `isBootstrapAdminLocked` to avoid dead-end clicks.
 */

import { env } from "@/lib/env";
import { ForbiddenError } from "@/lib/errors";

/**
 * Whether `email` identifies the locked bootstrap admin. False when the lock is
 * off, when no bootstrap email is configured, or when the emails don't match.
 * Comparison is case-insensitive (emails are stored/compared lower-cased).
 */
export function isBootstrapAdminLocked(email: string | null | undefined): boolean {
  if (!env.BOOTSTRAP_ADMIN_RO) return false;
  const bootstrap = env.BOOTSTRAP_ADMIN_EMAIL;
  if (!bootstrap || !email) return false;
  return email.toLowerCase() === bootstrap.toLowerCase();
}

/**
 * Throw `ForbiddenError` when `email` is the locked bootstrap admin. Call this
 * at every route that mutates a user's own identity or credentials, passing the
 * email of the account being changed (the current user for self-service routes,
 * the target user for admin routes).
 */
export function assertBootstrapAdminMutable(email: string | null | undefined): void {
  if (isBootstrapAdminLocked(email)) {
    throw new ForbiddenError("This demo account is read-only and cannot be modified.");
  }
}
