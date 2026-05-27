import { describe, expect, it } from "vitest";
import { evaluateSessionCompliance } from "./session-compliance";
import type { RoleSlice } from "./mfa-compliance";

const NO_ROLES: readonly RoleSlice[] = [];
const MFA_ROLE: readonly RoleSlice[] = [{ slug: "super-admin", requiresMfa: true }];
const NON_MFA_ROLE: readonly RoleSlice[] = [{ slug: "viewer", requiresMfa: false }];

/** Sensible defaults for a fully compliant local user. */
function base(overrides: Partial<Parameters<typeof evaluateSessionCompliance>[0]> = {}) {
  return {
    totpEnrolled: true,
    ssoOnly: false,
    mfaOverride: null,
    mustChangePassword: false,
    ...overrides,
  };
}

describe("evaluateSessionCompliance", () => {
  describe("compliant cases", () => {
    it("ok when no role requires MFA and password change isn't pending", () => {
      expect(evaluateSessionCompliance(base({ totpEnrolled: false }), NON_MFA_ROLE)).toEqual({
        ok: true,
      });
    });

    it("ok when an MFA-required role is present and TOTP is enrolled", () => {
      expect(evaluateSessionCompliance(base({ totpEnrolled: true }), MFA_ROLE)).toEqual({
        ok: true,
      });
    });

    it("ok with no roles and no password change pending", () => {
      expect(evaluateSessionCompliance(base({ totpEnrolled: false }), NO_ROLES)).toEqual({
        ok: true,
      });
    });
  });

  describe("mfa gate", () => {
    it("blocks with reason 'mfa' when a role requires MFA and TOTP is not enrolled", () => {
      expect(evaluateSessionCompliance(base({ totpEnrolled: false }), MFA_ROLE)).toEqual({
        ok: false,
        reason: "mfa",
      });
    });

    it("blocks with reason 'mfa' for override=true even without an MFA role", () => {
      expect(
        evaluateSessionCompliance(base({ totpEnrolled: false, mfaOverride: true }), NO_ROLES),
      ).toEqual({ ok: false, reason: "mfa" });
    });

    it("override=false exempts even when a role requires MFA", () => {
      expect(
        evaluateSessionCompliance(base({ totpEnrolled: false, mfaOverride: false }), MFA_ROLE),
      ).toEqual({ ok: true });
    });

    it("SSO-only accounts are exempt under inherit even with an MFA role", () => {
      expect(
        evaluateSessionCompliance(
          base({ totpEnrolled: false, ssoOnly: true, mfaOverride: null }),
          MFA_ROLE,
        ),
      ).toEqual({ ok: true });
    });

    it("SSO-only accounts stay exempt even with a stale override=true (legacy rows aren't lockouts)", () => {
      // Per lib/auth/mfa-compliance.ts: the admin UI hides + the API rejects
      // setting mfaOverride=true for SSO users; this guards legacy rows.
      expect(
        evaluateSessionCompliance(
          base({ totpEnrolled: false, ssoOnly: true, mfaOverride: true }),
          NO_ROLES,
        ),
      ).toEqual({ ok: true });
    });

    it("treats mfaOverride === undefined the same as null (inherit)", () => {
      expect(
        evaluateSessionCompliance(base({ totpEnrolled: false, mfaOverride: undefined }), MFA_ROLE),
      ).toEqual({ ok: false, reason: "mfa" });
    });
  });

  describe("must-change-password gate", () => {
    it("blocks with reason 'must-change-password' when the flag is set", () => {
      expect(evaluateSessionCompliance(base({ mustChangePassword: true }), NON_MFA_ROLE)).toEqual({
        ok: false,
        reason: "must-change-password",
      });
    });

    it("blocks even with no roles when the flag is set", () => {
      expect(evaluateSessionCompliance(base({ mustChangePassword: true }), NO_ROLES)).toEqual({
        ok: false,
        reason: "must-change-password",
      });
    });
  });

  describe("gate ordering", () => {
    it("reports 'mfa' first when both gates are tripped", () => {
      expect(
        evaluateSessionCompliance(
          base({ totpEnrolled: false, mustChangePassword: true }),
          MFA_ROLE,
        ),
      ).toEqual({ ok: false, reason: "mfa" });
    });

    it("falls through to 'must-change-password' once MFA is satisfied", () => {
      expect(
        evaluateSessionCompliance(base({ totpEnrolled: true, mustChangePassword: true }), MFA_ROLE),
      ).toEqual({ ok: false, reason: "must-change-password" });
    });
  });
});
