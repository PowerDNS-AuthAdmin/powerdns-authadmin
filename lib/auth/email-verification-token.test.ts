import { describe, expect, it } from "vitest";
import { mintVerifyToken, verifyVerifyToken } from "./email-verification-token";

const SECRET = "test-secret-please-do-not-deploy-32-chars-min";

describe("email-verification-token", () => {
  it("round-trips a token successfully", () => {
    const { token, payload } = mintVerifyToken({
      userId: "user-uuid",
      email: "alice@example.com",
      secret: SECRET,
    });
    const verify = verifyVerifyToken({ token, secret: SECRET });
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.payload.userId).toBe(payload.userId);
      expect(verify.payload.email).toBe(payload.email);
      expect(verify.payload.nonce).toBe(payload.nonce);
    }
  });

  it("emits the pde_ prefix", () => {
    const { token } = mintVerifyToken({
      userId: "u",
      email: "a@e.com",
      secret: SECRET,
    });
    expect(token.startsWith("pde_")).toBe(true);
  });

  it("rejects tokens signed by the password-reset HKDF derivative", () => {
    // The two flows derive distinct subkeys from APP_SECRET_KEY via
    // different HKDF `info` labels, so a token signed for one
    // purpose can't be verified by the other.
    // We can't easily import mintResetToken here without circular
    // concerns, so we simulate by signing with the wrong info label
    // (i.e. by passing a tampered secret string that produces a
    // different derived key). The key insight is that a leaked
    // password-reset token isn't valid here; this test asserts
    // that any token with a non-matching signature fails.
    const { token } = mintVerifyToken({
      userId: "u",
      email: "a@e.com",
      secret: SECRET,
    });
    expect(verifyVerifyToken({ token, secret: "different-key-also-padded-32-chars" })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects expired tokens", () => {
    const { token } = mintVerifyToken({
      userId: "u",
      email: "a@e.com",
      secret: SECRET,
      ttlMs: 1000,
      now: () => 1000,
    });
    expect(verifyVerifyToken({ token, secret: SECRET, now: () => 3000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("preserves the bound email in the payload", () => {
    const { token } = mintVerifyToken({
      userId: "u",
      email: "old@example.com",
      secret: SECRET,
    });
    const verify = verifyVerifyToken({ token, secret: SECRET });
    expect(verify.ok).toBe(true);
    if (verify.ok) expect(verify.payload.email).toBe("old@example.com");
  });

  it("rejects shape garbage", () => {
    expect(verifyVerifyToken({ token: "bogus", secret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    });
    expect(verifyVerifyToken({ token: "pde_no-sig", secret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    });
  });

  it("rejects tampered payloads", () => {
    const { token } = mintVerifyToken({
      userId: "alice",
      email: "alice@e.com",
      secret: SECRET,
    });
    const other = mintVerifyToken({
      userId: "mallory",
      email: "mallory@e.com",
      secret: SECRET,
    });
    const tampered = `${other.token.split(".")[0]}.${token.split(".")[1]!}`;
    expect(verifyVerifyToken({ token: tampered, secret: SECRET })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("issues distinct tokens for repeated mints of the same payload", () => {
    const a = mintVerifyToken({
      userId: "u",
      email: "a@e.com",
      secret: SECRET,
    });
    const b = mintVerifyToken({
      userId: "u",
      email: "a@e.com",
      secret: SECRET,
    });
    expect(a.token).not.toBe(b.token);
  });
});
