import { describe, expect, it } from "vitest";
import { shouldAutoBounceToDefault } from "./login-auto-bounce";

const base = { signedOut: false, forceLocal: false, justLoggedOut: false };

describe("shouldAutoBounceToDefault", () => {
  it("bounces on a plain visit", () => {
    expect(shouldAutoBounceToDefault({ ...base })).toBe(true);
  });

  it("bounces after a session expiry or revocation (the bug: the form was shown instead)", () => {
    expect(shouldAutoBounceToDefault({ ...base, flash: "session-required" })).toBe(true);
    expect(shouldAutoBounceToDefault({ ...base, error: "session-expired" })).toBe(true);
  });

  it("stays on the page after an explicit sign-out", () => {
    expect(shouldAutoBounceToDefault({ ...base, signedOut: true })).toBe(false);
    expect(shouldAutoBounceToDefault({ ...base, justLoggedOut: true })).toBe(false);
  });

  it("stays on the page when the operator asks for the local form", () => {
    expect(shouldAutoBounceToDefault({ ...base, forceLocal: true })).toBe(false);
    expect(
      shouldAutoBounceToDefault({ ...base, forceLocal: true, flash: "session-required" }),
    ).toBe(false);
  });

  it("stays on the page when there is an error or notice to read", () => {
    expect(shouldAutoBounceToDefault({ ...base, error: "oidc-exchange-failed" })).toBe(false);
    expect(shouldAutoBounceToDefault({ ...base, error: "oidc-not-authorized" })).toBe(false);
    expect(shouldAutoBounceToDefault({ ...base, flash: "email-changed" })).toBe(false);
  });
});
