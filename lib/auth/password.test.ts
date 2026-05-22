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
