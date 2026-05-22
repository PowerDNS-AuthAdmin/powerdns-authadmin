import { describe, expect, it } from "vitest";
import { mintResetToken, verifyResetToken } from "./password-reset-token";

const SECRET = "test-secret-please-do-not-deploy-32-chars-min";

describe("password-reset-token", () => {
  it("round-trips a token successfully", () => {
    const { token, payload } = mintResetToken({
      userId: "user-uuid-1",
      secret: SECRET,
    });
    const verify = verifyResetToken({ token, secret: SECRET });
    expect(verify.ok).toBe(true);
    if (verify.ok) {
      expect(verify.payload.userId).toBe(payload.userId);
      expect(verify.payload.nonce).toBe(payload.nonce);
      expect(verify.payload.issuedAt).toBe(payload.issuedAt);
      expect(verify.payload.expiresAt).toBe(payload.expiresAt);
    }
  });

  it("emits the pdr_ prefix", () => {
    const { token } = mintResetToken({ userId: "u", secret: SECRET });
    expect(token.startsWith("pdr_")).toBe(true);
  });

  it("generates a fresh nonce per mint (same input → different tokens)", () => {
    const a = mintResetToken({ userId: "u", secret: SECRET });
    const b = mintResetToken({ userId: "u", secret: SECRET });
    expect(a.token).not.toBe(b.token);
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
  });

  it("respects an overridden TTL", () => {
    const { payload } = mintResetToken({
      userId: "u",
      secret: SECRET,
      ttlMs: 60_000,
      now: () => 1_000_000,
    });
    expect(payload.issuedAt).toBe(1_000_000);
    expect(payload.expiresAt).toBe(1_060_000);
  });

  it("rejects tokens without the pdr_ prefix", () => {
    expect(verifyResetToken({ token: "bogus", secret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    });
  });

  it("rejects tokens missing the .sig separator", () => {
    expect(verifyResetToken({ token: "pdr_only-payload", secret: SECRET })).toEqual({
      ok: false,
      reason: "shape",
    });
  });

  it("rejects tokens with a wrong signature", () => {
    const { token } = mintResetToken({ userId: "u", secret: SECRET });
    // Flip the last char of the signature.
    const broken = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(verifyResetToken({ token: broken, secret: SECRET })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects tokens signed with a different key", () => {
    const { token } = mintResetToken({ userId: "u", secret: SECRET });
    expect(verifyResetToken({ token, secret: "different-key-also-padded-32-chars-long" })).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects expired tokens", () => {
    const { token } = mintResetToken({
      userId: "u",
      secret: SECRET,
      ttlMs: 1000,
      now: () => 1000,
    });
    expect(verifyResetToken({ token, secret: SECRET, now: () => 3000 })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("accepts tokens right at the edge of the TTL", () => {
    // Token valid until 2000; now=1999 still ok, now=2000 expires
    // (strict less-than in the verifier).
    const { token } = mintResetToken({
      userId: "u",
      secret: SECRET,
      ttlMs: 1000,
      now: () => 1000,
    });
    expect(verifyResetToken({ token, secret: SECRET, now: () => 1999 }).ok).toBe(true);
    expect(verifyResetToken({ token, secret: SECRET, now: () => 2000 }).ok).toBe(false);
  });

  it("rejects a tampered payload (modified userId)", () => {
    const { token } = mintResetToken({ userId: "alice", secret: SECRET });
    // Swap the payload base64 portion for a different one with the
    // same signature copied over — should fail signature.
    const swapped = mintResetToken({ userId: "mallory", secret: SECRET });
    const swappedBody = swapped.token.split(".")[0];
    const originalSig = token.split(".")[1];
    const tampered = `${swappedBody}.${originalSig!}`;
    expect(verifyResetToken({ token: tampered, secret: SECRET })).toEqual({
      ok: false,
      reason: "signature",
    });
  });
});
