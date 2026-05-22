import { describe, expect, it } from "vitest";
import { checkMfaCompliance } from "./mfa-compliance";

describe("checkMfaCompliance", () => {
  it("returns compliant when no role requires MFA, regardless of enrollment", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false }, [
        { slug: "viewer", requiresMfa: false },
        { slug: "editor", requiresMfa: false },
      ]),
    ).toEqual({ compliant: true });
    expect(
      checkMfaCompliance({ totpEnrolled: true }, [{ slug: "viewer", requiresMfa: false }]),
    ).toEqual({ compliant: true });
  });

  it("returns compliant when a role requires MFA and TOTP is enrolled", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: true }, [{ slug: "super-admin", requiresMfa: true }]),
    ).toEqual({ compliant: true });
  });

  it("returns non-compliant when an MFA-required role is present and no enrollment", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false }, [{ slug: "super-admin", requiresMfa: true }]),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["super-admin"],
    });
  });

  it("lists every role that triggered the requirement, alphabetically", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false }, [
        { slug: "ops", requiresMfa: true },
        { slug: "ignored", requiresMfa: false },
        { slug: "billing", requiresMfa: true },
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["billing", "ops", "super-admin"],
    });
  });

  it("substitutes a placeholder when a triggering role has no slug", () => {
    expect(checkMfaCompliance({ totpEnrolled: false }, [{ requiresMfa: true }])).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["(unnamed role)"],
    });
  });

  it("handles the empty-roles case (no roles → compliant)", () => {
    expect(checkMfaCompliance({ totpEnrolled: false }, [])).toEqual({
      compliant: true,
    });
  });
});

describe("checkMfaCompliance — SSO exemption + per-user override", () => {
  it("SSO-only accounts are exempt under inherit, even with an MFA-required role", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, ssoOnly: true }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("override=false exempts even when a role requires MFA", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, mfaOverride: false }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("override=true requires MFA even with no role requiring it (and even for SSO)", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, mfaOverride: true, ssoOnly: true }, []),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["(per-user override)"],
    });
  });

  it("override=true is satisfied once TOTP is enrolled", () => {
    expect(checkMfaCompliance({ totpEnrolled: true, mfaOverride: true }, [])).toEqual({
      compliant: true,
    });
  });
});
