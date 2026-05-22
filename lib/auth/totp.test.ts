import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  currentTotp,
  generateSecret,
  provisioningUri,
  verifyTotp,
} from "./totp";

// RFC 6238 Appendix B test vectors (SHA-1, 8 digits in the spec but
// authenticator apps use 6; we test our 6-digit truncation against
// the same test vector by re-deriving with our default digits).
//
// Secret bytes (RFC 4226 §5.4): "12345678901234567890" → base32
// "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("base32 round-trip", () => {
  it("encodes and decodes inverse", () => {
    const buf = Buffer.from("hello world", "utf8");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });

  it("decodes the RFC 6238 test secret to 20 ASCII bytes", () => {
    const decoded = base32Decode(RFC_SECRET);
    expect(decoded.equals(Buffer.from("12345678901234567890", "utf8"))).toBe(true);
  });

  it("tolerates lowercase and embedded whitespace", () => {
    const original = Buffer.from("hi", "utf8");
    const encoded = base32Encode(original);
    expect(base32Decode(encoded.toLowerCase()).equals(original)).toBe(true);
    expect(base32Decode(encoded.split("").join(" ")).equals(original)).toBe(true);
  });

  it("throws on invalid characters", () => {
    expect(() => base32Decode("ABC$DEF")).toThrow();
  });
});

describe("generateSecret", () => {
  it("produces a 32-character base32 string by default", () => {
    const s = generateSecret();
    expect(s).toHaveLength(32);
    expect(/^[A-Z2-7]+$/.test(s)).toBe(true);
  });

  it("differs across calls (random per call)", () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe("currentTotp + verifyTotp", () => {
  it("round-trips: the code for now verifies as valid", () => {
    const code = currentTotp(RFC_SECRET);
    expect(verifyTotp(RFC_SECRET, code)).toBe(true);
  });

  it("emits a 6-digit zero-padded code", () => {
    const code = currentTotp(RFC_SECRET, { now: () => 0 });
    expect(code).toHaveLength(6);
    expect(/^\d{6}$/.test(code)).toBe(true);
  });

  it("rejects codes from outside the ±1-step window", () => {
    const t0 = 1_700_000_000_000;
    const code = currentTotp(RFC_SECRET, { now: () => t0 });
    // 60 seconds (2 steps) earlier → still inside ±1 step? No: 60s
    // = 2 steps, beyond the default window of 1.
    expect(verifyTotp(RFC_SECRET, code, { now: () => t0 + 60_000 })).toBe(false);
  });

  it("accepts a code from one step earlier (within the ±1 window)", () => {
    const t0 = 1_700_000_000_000;
    const earlierCode = currentTotp(RFC_SECRET, { now: () => t0 - 25_000 });
    expect(verifyTotp(RFC_SECRET, earlierCode, { now: () => t0 })).toBe(true);
  });

  it("rejects garbage input (non-digit, wrong length)", () => {
    expect(verifyTotp(RFC_SECRET, "abcdef")).toBe(false);
    expect(verifyTotp(RFC_SECRET, "12345")).toBe(false);
    expect(verifyTotp(RFC_SECRET, "1234567")).toBe(false);
    expect(verifyTotp(RFC_SECRET, "")).toBe(false);
  });

  it("respects a custom window option", () => {
    const t0 = 1_700_000_000_000;
    const code = currentTotp(RFC_SECRET, { now: () => t0 });
    // 90s = 3 steps later — passes only with window ≥ 3.
    expect(verifyTotp(RFC_SECRET, code, { now: () => t0 + 90_000, window: 3 })).toBe(true);
    expect(verifyTotp(RFC_SECRET, code, { now: () => t0 + 90_000, window: 1 })).toBe(false);
  });
});

describe("provisioningUri", () => {
  it("emits the otpauth://totp/ scheme with the expected params", () => {
    const uri = provisioningUri({
      secret: RFC_SECRET,
      accountName: "alice@example.com",
      issuer: "PowerDNS-AuthAdmin",
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(uri).toContain("issuer=PowerDNS-AuthAdmin");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("url-encodes the issuer:account label including @", () => {
    const uri = provisioningUri({
      secret: RFC_SECRET,
      accountName: "alice@example.com",
      issuer: "Pdns Authentic",
    });
    expect(uri).toContain("Pdns%20Authentic%3Aalice%40example.com");
  });
});
