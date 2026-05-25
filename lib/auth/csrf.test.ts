/**
 * lib/auth/csrf.test.ts
 *
 * Unit coverage for `verifyCsrf`, the pure constant-time comparison at the
 * heart of the double-submit CSRF check. The length-mismatch branch is the
 * load-bearing one: `timingSafeEqual` throws on differing buffer lengths, so
 * the implementation pads to equal length to keep the comparison constant-time
 * AND avoid the throw. A regression there would turn a forged-token attempt
 * with a wrong-length token into a 500 instead of a clean `false`.
 */

import { describe, expect, it } from "vitest";
import { verifyCsrf } from "./csrf";

const SECRET = "s3cr3t-csrf-token-value-0123456789";

describe("verifyCsrf", () => {
  it("returns true when the header matches the session secret exactly", () => {
    expect(verifyCsrf(SECRET, SECRET)).toBe(true);
  });

  it("returns false for a same-length but different token", () => {
    const wrong = "x".repeat(SECRET.length);
    expect(wrong).not.toBe(SECRET);
    expect(wrong.length).toBe(SECRET.length);
    expect(verifyCsrf(wrong, SECRET)).toBe(false);
  });

  it("returns false WITHOUT throwing when the header is shorter than the secret", () => {
    expect(() => verifyCsrf("short", SECRET)).not.toThrow();
    expect(verifyCsrf("short", SECRET)).toBe(false);
  });

  it("returns false WITHOUT throwing when the header is longer than the secret", () => {
    const longer = `${SECRET}-with-extra-suffix`;
    expect(longer.length).toBeGreaterThan(SECRET.length);
    expect(() => verifyCsrf(longer, SECRET)).not.toThrow();
    expect(verifyCsrf(longer, SECRET)).toBe(false);
  });

  it("returns false for a null header", () => {
    expect(verifyCsrf(null, SECRET)).toBe(false);
  });

  it("returns false for an empty-string header (length mismatch, no throw)", () => {
    expect(() => verifyCsrf("", SECRET)).not.toThrow();
    expect(verifyCsrf("", SECRET)).toBe(false);
  });
});
