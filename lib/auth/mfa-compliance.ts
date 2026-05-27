/**
 * lib/auth/mfa-compliance.ts
 *
 * Pure check: is a user MFA-compliant given the policy on their
 * assigned roles? Returns `{ compliant: true }` when EITHER no
 * assigned role requires MFA OR the user has at least one MFA
 * method enrolled (TOTP OR a WebAuthn credential). Returns
 * `{ compliant: false, reason }` so the caller can render a useful
 * message.
 *
 * The role input shape matches what `loadUserAssignmentsForAbility`
 * + a roles join would return; it's redeclared inline here so the
 * helper doesn't take a dep on the DB layer (testable without `pg`).
 */

export interface RoleSlice {
  /** Whether THIS role requires the operator to have MFA. */
  requiresMfa: boolean;
  /** For diagnostic output ("required by role X, Y"). */
  slug?: string;
}

export interface UserMfaState {
  /** Has at least one TOTP enrollment. */
  totpEnrolled: boolean;
  /** Has at least one WebAuthn credential (passkey or hardware key). */
  webauthnEnrolled: boolean;
  /**
   * SSO-only account (no local password). The IdP is the second-factor
   * authority — the in-app TOTP flow renders read-only for SSO and the
   * admin UI hides the per-user MFA override for them, so SSO accounts
   * are ALWAYS exempt from this gate (only `mfaOverride === false`
   * short-circuits earlier — same outcome). Default false.
   */
  ssoOnly?: boolean;
  /**
   * Per-user MFA override: `true` = always require MFA, `false` = never
   * require, `null`/`undefined` = inherit (role-based). The `true` value is
   * inert for SSO-only users (see `ssoOnly`); the admin UI prevents writing
   * it and `checkMfaCompliance` ignores legacy rows that carry it.
   */
  mfaOverride?: boolean | null;
}

export type ComplianceResult =
  | { compliant: true }
  | {
      compliant: false;
      reason: "no-mfa-enrolled";
      /** Slugs of the roles that triggered the requirement, for the UI. */
      requiringRoleSlugs: string[];
    };

/**
 * Determine MFA compliance.
 *
 * @example
 *   const result = checkMfaCompliance(
 *     { totpEnrolled: user.totpSecretEncrypted !== null },
 *     userRoles,
 *   );
 *   if (!result.compliant) {
 *     return redirect(`/profile?mfa-required=1&because=${result.requiringRoleSlugs.join(",")}`);
 *   }
 */
export function checkMfaCompliance(
  user: UserMfaState,
  roles: readonly RoleSlice[],
): ComplianceResult {
  // The per-user override wins over everything — roles AND the SSO exemption.
  if (user.mfaOverride === false) return { compliant: true };

  // SSO-only users can't enroll TOTP in this app: the IdP is the second-factor
  // authority. Forcing MFA on an SSO account would just deadlock it (the
  // /profile TOTP section renders read-only for SSO). The admin UI hides the
  // per-user override for SSO users and the PATCH endpoint refuses to set it
  // to `true`, but we still defend against legacy rows that carried that
  // setting before the policy landed — treat them as compliant rather than
  // lock the operator out.
  if (user.ssoOnly) return { compliant: true };

  let requiringRoleSlugs: string[];
  if (user.mfaOverride === true) {
    requiringRoleSlugs = ["(per-user override)"];
  } else {
    // Inherit: any role marked requiresMfa.
    const requiringRoles = roles.filter((r) => r.requiresMfa);
    if (requiringRoles.length === 0) return { compliant: true };
    requiringRoleSlugs = requiringRoles.map((r) => r.slug ?? "(unnamed role)").sort();
  }

  if (user.totpEnrolled || user.webauthnEnrolled) return { compliant: true };
  return { compliant: false, reason: "no-mfa-enrolled", requiringRoleSlugs };
}
