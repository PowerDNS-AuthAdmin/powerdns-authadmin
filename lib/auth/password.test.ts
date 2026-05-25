/**
 * lib/auth/password.test.ts
 *
 * Sanity checks on the password hashing layer. Argon2 itself is well-tested
 * upstream; these tests cover our wrapping.
 */

import { describe, expect, it } from "vitest";
import { hashPassword, needsRehash, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces a PHC-format Argon2id hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("verifies a matching password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword(hash, "hunter2")).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("hunter2");
    expect(await verifyPassword(hash, "hunter3")).toBe(false);
  });

  it("rejects an empty plaintext rather than hashing it", async () => {
    await expect(hashPassword("")).rejects.toThrow(/empty password/);
  });

  it("returns false for a malformed hash without throwing", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("returns false for needsRehash on a current-param hash", async () => {
    const hash = await hashPassword("hunter2");
    expect(needsRehash(hash)).toBe(false);
  });
});

describe("needsRehash true-paths", () => {
  // `needsRehash` only reads the PHC parameters, not the salt/hash bytes, so
  // synthetic PHC strings (with placeholder salt + hash) exercise every branch
  // without paying for a real Argon2 hash. Current target is
  // m=19456, t=2, p=1, argon2id, v=19.
  const SALT_AND_HASH = "c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaA";
  const phc = (algo: string, version: number, m: number, t: number, p: number) =>
    `$${algo}$v=${version}$m=${m},t=${t},p=${p}$${SALT_AND_HASH}`;

  it("a baseline synthetic hash at current params is NOT rehashed (control)", () => {
    expect(needsRehash(phc("argon2id", 19, 19_456, 2, 1))).toBe(false);
  });

  it("rehashes when memoryCost is lower than the current target", () => {
    expect(needsRehash(phc("argon2id", 19, 4_096, 2, 1))).toBe(true);
  });

  it("rehashes when timeCost is lower than the current target", () => {
    expect(needsRehash(phc("argon2id", 19, 19_456, 1, 1))).toBe(true);
  });

  it("rehashes when parallelism differs from the current target", () => {
    expect(needsRehash(phc("argon2id", 19, 19_456, 2, 4))).toBe(true);
  });

  it("rehashes a non-argon2id algorithm (e.g. argon2i)", () => {
    expect(needsRehash(phc("argon2i", 19, 19_456, 2, 1))).toBe(true);
  });

  it("rehashes a hash minted with a different argon2 version", () => {
    expect(needsRehash(phc("argon2id", 16, 19_456, 2, 1))).toBe(true);
  });

  it("rehashes a malformed PHC string rather than refusing the login", () => {
    expect(needsRehash("not-a-phc-string")).toBe(true);
    expect(needsRehash("$argon2id$v=19$m=19456,t=2,p=1")).toBe(true);
    expect(needsRehash("$argon2id$missing-version$m=19456,t=2,p=1$x$y")).toBe(true);
    expect(needsRehash("$argon2id$v=19$t=2,p=1$x$y")).toBe(true);
  });
});
