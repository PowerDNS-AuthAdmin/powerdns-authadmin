import { describe, expect, it } from "vitest";
import { decrypt, encrypt, looksLikeEnvelope } from "./encryption";

/**
 * AES-256-GCM envelope encryption. The master key comes from
 * APP_ENCRYPTION_KEY, primed by tests/setup.ts. Wrong-key behavior is
 * exercised via the `usage` subkey (HKDF derives a distinct key per usage),
 * which is the same property as "decrypt with the wrong key fails" without
 * having to mutate the validated env.
 */
describe("encrypt / decrypt round-trip", () => {
  it("recovers the plaintext", () => {
    expect(decrypt(encrypt("hunter2"))).toBe("hunter2");
  });

  it("round-trips an empty string", () => {
    expect(decrypt(encrypt(""))).toBe("");
  });

  it("round-trips unicode and long inputs", () => {
    const s = "🔐 café — " + "x".repeat(10_000);
    expect(decrypt(encrypt(s))).toBe(s);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encrypt("same");
    const b = encrypt("same");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("same");
    expect(decrypt(b)).toBe("same");
  });

  it("keeps usages isolated — decrypting with a different usage fails", () => {
    const env = encrypt("secret", "session-cookie");
    expect(decrypt(env, "session-cookie")).toBe("secret");
    expect(() => decrypt(env, "db-column")).toThrow();
  });
});

describe("decrypt — tamper + format rejection", () => {
  function reencode(part: string, mutate: (b: Buffer) => void): string {
    const buf = Buffer.from(part, "base64url");
    mutate(buf);
    return buf.toString("base64url");
  }

  it("rejects a tampered ciphertext (auth tag mismatch)", () => {
    const [v, iv, ct, tag] = encrypt("payload").split(":");
    const tampered = [
      v,
      iv,
      reencode(ct!, (b) => {
        b[0] = (b[0] ?? 0) ^ 0xff;
      }),
      tag,
    ].join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const [v, iv, ct, tag] = encrypt("payload").split(":");
    const tampered = [
      v,
      iv,
      ct,
      reencode(tag!, (b) => {
        b[0] = (b[0] ?? 0) ^ 0xff;
      }),
    ].join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a tampered IV", () => {
    const [v, iv, ct, tag] = encrypt("payload").split(":");
    const tampered = [
      v,
      reencode(iv!, (b) => {
        b[0] = (b[0] ?? 0) ^ 0xff;
      }),
      ct,
      tag,
    ].join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a wrong-shaped envelope", () => {
    expect(() => decrypt("not-an-envelope")).toThrow(/wrong shape/i);
    expect(() => decrypt("a:b:c")).toThrow(/wrong shape/i);
  });

  it("rejects an unsupported version", () => {
    const [, iv, ct, tag] = encrypt("payload").split(":");
    expect(() => decrypt(["v2", iv, ct, tag].join(":"))).toThrow(/version/i);
  });
});

describe("looksLikeEnvelope", () => {
  it("is true for a real envelope", () => {
    expect(looksLikeEnvelope(encrypt("x"))).toBe(true);
  });

  it("is false for plaintext and partial shapes", () => {
    expect(looksLikeEnvelope("plaintext")).toBe(false);
    expect(looksLikeEnvelope("v1:onlytwo")).toBe(false);
    expect(looksLikeEnvelope("")).toBe(false);
  });
});
