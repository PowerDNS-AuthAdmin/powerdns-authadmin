/**
 * lib/auth/mfa-compliance.ts
 *
 * Pure check: is a user MFA-compliant given the policy on their
 * assigned roles? Returns `{ compliant: true }` when EITHER no
 * assigned role requires MFA OR the user has at least one MFA
 * method enrolled. Returns `{ compliant: false, reason }` so the
 * caller can render a useful message.
 *
 * Today we treat TOTP as the only MFA method. When WebAuthn /
 * passkeys land, the user-side input type can grow a second field
 * and the check becomes `totp || passkey`.
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
  /**
   * SSO-only account (no local password). Under "inherit" these are exempt —
   * the IdP is the second-factor authority. Default false.
   */
  ssoOnly?: boolean;
  /**
   * Per-user MFA override that SUPERSEDES roles (and, when set, the SSO
   * exemption): `true` = always require TOTP, `false` = never require,
   * `null`/`undefined` = inherit (SSO-exempt, else role-based).
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

  let requiringRoleSlugs: string[];
  if (user.mfaOverride === true) {
    requiringRoleSlugs = ["(per-user override)"];
  } else {
    // Inherit: SSO accounts are exempt; otherwise any role marked requiresMfa.
    if (user.ssoOnly) return { compliant: true };
    const requiringRoles = roles.filter((r) => r.requiresMfa);
    if (requiringRoles.length === 0) return { compliant: true };
    requiringRoleSlugs = requiringRoles.map((r) => r.slug ?? "(unnamed role)").sort();
  }

  if (user.totpEnrolled) return { compliant: true };
  return { compliant: false, reason: "no-mfa-enrolled", requiringRoleSlugs };
}
