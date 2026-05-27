/**
 * lib/auth/session-compliance.ts
 *
 * Pure decision: is a SESSION-authenticated user allowed to perform actions,
 * or must they first self-remediate? Two gates, in order:
 *
 *   1. MFA enrollment — when a user's role policy (or per-user override)
 *      requires MFA but they haven't enrolled TOTP. Delegates to
 *      `checkMfaCompliance` so the rule stays in one place.
 *   2. mustChangePassword — a temp/expired password that must be rotated
 *      before the account can do anything else.
 *
 * This is the single source of truth for the compliance gate that both the
 * `(app)` layout (page renders) and `requireUser` (route handlers) enforce.
 * Kept free of any DB import so it's unit-testable without `pg`/`better-sqlite3`
 * — callers pass the already-fetched role MFA states + user flags.
 *
 * The MFA gate matters only when a non-compliant user can still hold a live
 * session: TOTP enrollment is confirmed AFTER login, and the
 * `mustChangePassword` flag is set on accounts that authenticated with a temp
 * password. Both states are reachable with a full session, which is exactly
 * why the gate has to live below the page layer.
 */

import { checkMfaCompliance, type RoleSlice } from "./mfa-compliance";

export interface SessionComplianceInput {
  /** Has at least one TOTP enrollment (user.totpSecretEncrypted !== null). */
  totpEnrolled: boolean;
  /** Has at least one WebAuthn credential (user.webauthnCredentials.length > 0). */
  webauthnEnrolled: boolean;
  /** SSO-only account — no local password hash (passwordHash === null). */
  ssoOnly: boolean;
  /**
   * Per-user MFA override that supersedes roles + the SSO exemption
   * (user.mfaRequired): true = always require, false = never, null = inherit.
   */
  mfaOverride: boolean | null | undefined;
  /** The temp-password flag (user.mustChangePassword). */
  mustChangePassword: boolean;
}

export type SessionComplianceResult =
  | { ok: true }
  | { ok: false; reason: "mfa" | "must-change-password" };

/**
 * Evaluate whether a session is compliant. MFA is checked first so an
 * operator who is both non-enrolled AND flagged for a password change is sent
 * to the more security-critical remediation first; either way both gates have
 * to clear before the session can act.
 */
export function evaluateSessionCompliance(
  input: SessionComplianceInput,
  roleMfaStates: readonly RoleSlice[],
): SessionComplianceResult {
  const mfa = checkMfaCompliance(
    {
      totpEnrolled: input.totpEnrolled,
      webauthnEnrolled: input.webauthnEnrolled,
      ssoOnly: input.ssoOnly,
      mfaOverride: input.mfaOverride,
    },
    roleMfaStates,
  );
  if (!mfa.compliant) return { ok: false, reason: "mfa" };

  if (input.mustChangePassword) return { ok: false, reason: "must-change-password" };

  return { ok: true };
}
