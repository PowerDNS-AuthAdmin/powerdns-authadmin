import { describe, expect, it } from "vitest";
import { checkMfaCompliance } from "./mfa-compliance";

describe("checkMfaCompliance", () => {
  it("returns compliant when no role requires MFA, regardless of enrollment", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false }, [
        { slug: "viewer", requiresMfa: false },
        { slug: "editor", requiresMfa: false },
      ]),
    ).toEqual({ compliant: true });
    expect(
      checkMfaCompliance({ totpEnrolled: true, webauthnEnrolled: false }, [
        { slug: "viewer", requiresMfa: false },
      ]),
    ).toEqual({ compliant: true });
  });

  it("returns compliant when a role requires MFA and TOTP is enrolled", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: true, webauthnEnrolled: false }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("returns non-compliant when an MFA-required role is present and no enrollment", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["super-admin"],
    });
  });

  it("lists every role that triggered the requirement, alphabetically", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false }, [
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
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false }, [{ requiresMfa: true }]),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["(unnamed role)"],
    });
  });

  it("handles the empty-roles case (no roles → compliant)", () => {
    expect(checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false }, [])).toEqual({
      compliant: true,
    });
  });
});

describe("checkMfaCompliance - SSO exemption + per-user override", () => {
  it("SSO-only accounts are exempt under inherit, even with an MFA-required role", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false, ssoOnly: true }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("override=false exempts even when a role requires MFA", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false, mfaOverride: false }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("override=true requires MFA for local accounts with no role requiring it", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: false, mfaOverride: true }, []),
    ).toEqual({
      compliant: false,
      reason: "no-mfa-enrolled",
      requiringRoleSlugs: ["(per-user override)"],
    });
  });

  it("SSO-only accounts stay exempt even with a stale override=true (legacy rows aren't lockouts)", () => {
    // The admin UI hides the override for SSO users and the PATCH endpoint
    // rejects setting it to true; this guards against legacy DB rows that
    // were written before that policy landed.
    expect(
      checkMfaCompliance(
        { totpEnrolled: false, webauthnEnrolled: false, mfaOverride: true, ssoOnly: true },
        [],
      ),
    ).toEqual({ compliant: true });
  });

  it("override=true is satisfied once TOTP is enrolled", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: true, webauthnEnrolled: false, mfaOverride: true }, []),
    ).toEqual({
      compliant: true,
    });
  });
});

describe("checkMfaCompliance - WebAuthn satisfies the gate", () => {
  it("a passkey alone is enough to satisfy a role-required gate", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: true }, [
        { slug: "super-admin", requiresMfa: true },
      ]),
    ).toEqual({ compliant: true });
  });

  it("a passkey alone is enough to satisfy a per-user override gate", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: true, mfaOverride: true }, []),
    ).toEqual({ compliant: true });
  });

  it("EITHER TOTP or WebAuthn satisfies the gate (OR-semantics)", () => {
    expect(
      checkMfaCompliance({ totpEnrolled: true, webauthnEnrolled: false }, [
        { requiresMfa: true, slug: "admin" },
      ]),
    ).toEqual({ compliant: true });
    expect(
      checkMfaCompliance({ totpEnrolled: false, webauthnEnrolled: true }, [
        { requiresMfa: true, slug: "admin" },
      ]),
    ).toEqual({ compliant: true });
    expect(
      checkMfaCompliance({ totpEnrolled: true, webauthnEnrolled: true }, [
        { requiresMfa: true, slug: "admin" },
      ]),
    ).toEqual({ compliant: true });
  });
});
