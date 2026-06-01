/**
 * lib/auth/password.ts
 *
 * Password hashing and verification - Argon2id, per ADR 0008.
 *
 * Backed by `@node-rs/argon2` (a napi-rs binding to the Rust `argon2` crate).
 * Why this binding over the `argon2` npm package: napi-rs ships prebuilt
 * platform binaries via optional deps, so we don't need `node-gyp` or to
 * relax `--ignore-scripts` in the Dockerfile. Same Argon2id algorithm,
 * same standard PHC hash format on the wire.
 *
 * Parameters track OWASP's current Password Storage Cheat Sheet (reviewed
 * yearly). The library produces standard PHC-format hashes that encode the
 * parameters, so a future parameter bump doesn't invalidate existing hashes
 * - `needsRehash` tells us when to re-hash an old one on next successful login.
 *
 * `@node-rs/argon2` v2 does not export a `needsRehash` helper, so we
 * implement one by parsing the PHC string ourselves. This is a small
 * amount of code we control vs. a library dependency we don't.
 */

import "server-only";
import { hash, verify } from "@node-rs/argon2";
// Type-only import - `Algorithm` is declared as a `const enum` in
// `@node-rs/argon2`, which can't be referenced by name across modules with
// TypeScript's `isolatedModules` flag (required by Next.js). We import the
// type alone and use the numeric value below.
import type { Algorithm, Options } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id = 2` per the library's const enum. We assert the
 * numeric value to the enum type so the rest of the call site stays typed.
 */
const ARGON2ID: Algorithm = 2;

/**
 * OWASP Password Storage Cheat Sheet defaults (Argon2id, December 2024 review).
 * Memory dominates the cost; iterations and parallelism follow.
 *
 * Field name map for `@node-rs/argon2`:
 *   memoryCost  → memory cost in KiB
 *   timeCost    → iteration count
 *   parallelism → degree of parallelism
 *   outputLen   → hash output length in bytes
 */
const ARGON2_OPTIONS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // ≈19 MiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
};

/**
 * Hash a password. Returns the PHC-format hash string suitable for storing in
 * `users.password_hash`. The salt is generated internally by the library.
 *
 * @example
 *   const hash = await hashPassword("hunter2");
 *   // → "$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>"
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (!plaintext) throw new Error("Refusing to hash an empty password.");
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verify a password against a stored hash. Returns true on match.
 *
 * Catches verification errors and returns false rather than throwing - the
 * caller doesn't need to distinguish "wrong password" from "malformed hash";
 * both mean "do not let this user in." The original error is logged by the
 * caller's logger if relevant.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext);
  } catch {
    return false;
  }
}

/**
 * True if the stored hash was produced with parameters weaker than current
 * `ARGON2_OPTIONS`. Call this after a successful verify; if true, re-hash
 * and write back to the DB.
 *
 * Implementation note: parses the PHC hash string and compares its `m`, `t`,
 * `p` parameters against our current target. Also re-hashes when the
 * algorithm identifier or version differs (defensive: a future bump should
 * re-hash on next login even if the math happens to overlap).
 *
 * PHC format:
 *   $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
 *
 * @param storedHash the hash to inspect.
 * @returns true if a rehash should occur on next successful verify.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const parsed = parsePhc(storedHash);
    if (parsed.algorithm !== "argon2id") return true;
    if (parsed.version !== 19) return true;
    if (parsed.memoryCost < ARGON2_OPTIONS.memoryCost!) return true;
    if (parsed.timeCost < ARGON2_OPTIONS.timeCost!) return true;
    if (parsed.parallelism !== ARGON2_OPTIONS.parallelism) return true;
    return false;
  } catch {
    // Malformed hash - easier to re-hash than to refuse the login.
    return true;
  }
}

interface ParsedPhc {
  algorithm: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Parse the PHC string format Argon2 uses. We care about the parameters,
 * not the salt or hash bytes. Throws on anything that doesn't look like an
 * Argon2 PHC string.
 */
function parsePhc(s: string): ParsedPhc {
  // Expected segments, separated by `$`:
  //   "" "argon2id" "v=19" "m=19456,t=2,p=1" "<salt>" "<hash>"
  const parts = s.split("$");
  if (parts.length < 6) throw new Error("Not a valid PHC string.");

  const algorithm = parts[1];
  const versionField = parts[2];
  const paramField = parts[3];
  if (!algorithm || !versionField || !paramField) {
    throw new Error("Not a valid PHC string.");
  }
  if (!versionField.startsWith("v=")) {
    throw new Error("Missing version field in PHC string.");
  }
  const version = Number(versionField.slice(2));
  if (!Number.isInteger(version)) {
    throw new Error("Non-integer version in PHC string.");
  }

  const params: Record<string, number> = {};
  for (const pair of paramField.split(",")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined) throw new Error("Malformed PHC params.");
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`Non-integer PHC param ${k}.`);
    params[k] = n;
  }

  const m = params["m"];
  const t = params["t"];
  const p = params["p"];
  if (m === undefined || t === undefined || p === undefined) {
    throw new Error("Missing m/t/p in PHC params.");
  }

  return {
    algorithm,
    version,
    memoryCost: m,
    timeCost: t,
    parallelism: p,
  };
}
