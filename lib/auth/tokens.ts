/**
 * lib/auth/tokens.ts
 *
 * Personal Access Tokens (PATs) for API access. Tokens look like:
 *
 *   pda_pat_<24 base64url chars of random>
 *
 * The first 8 random chars are stored cleartext as `prefix` for at-rest
 * identification (e.g. "which token is this leaked log line referring to?").
 * The full plaintext is shown to the user ONCE at creation and stored as an
 * Argon2id hash.
 *
 * Re-verification on every use: when a token is presented, we look up by
 * prefix (cheap, indexed), verify the Argon2 hash, then re-check the
 * token's scopes against the user's current effective permissions. This
 * means permission revocation propagates immediately to tokens.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "./password";

/** Prefix marker — public, looks like GitHub PATs ("ghp_..."). */
export const TOKEN_PREFIX = "pda_pat_";

/** Length of the random portion (base64url chars). */
const TOKEN_BODY_LEN = 32;

/** Length of the public prefix (after `pda_pat_`) we store cleartext. */
const PUBLIC_PREFIX_LEN = 8;

export interface NewTokenMaterial {
  /** The plaintext token. Show once, never again. */
  plaintext: string;
  /** Public prefix to store in the DB. */
  prefix: string;
  /** Argon2id hash to store in the DB. */
  hash: string;
}

/**
 * Generate a new token. Returns the plaintext, the public prefix, and the
 * Argon2 hash to persist. The plaintext should be displayed to the user
 * exactly once and then discarded.
 */
export async function generateToken(): Promise<NewTokenMaterial> {
  // Body bytes → base64url. 24 random bytes → 32 chars.
  const body = randomBytes(24).toString("base64url");
  if (body.length < TOKEN_BODY_LEN) {
    throw new Error("Random body shorter than expected.");
  }
  const plaintext = `${TOKEN_PREFIX}${body}`;
  const prefix = body.slice(0, PUBLIC_PREFIX_LEN);
  const hash = await hashPassword(plaintext);
  return { plaintext, prefix, hash };
}

/**
 * Split a presented token into its prefix and the part to verify. Returns
 * null for shapes that don't match the contract — handles abuse cases
 * (random garbage, JWTs, etc.) without throwing.
 */
export function parsePresentedToken(presented: string): { prefix: string } | null {
  if (!presented.startsWith(TOKEN_PREFIX)) return null;
  const body = presented.slice(TOKEN_PREFIX.length);
  if (body.length !== TOKEN_BODY_LEN) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  return { prefix: body.slice(0, PUBLIC_PREFIX_LEN) };
}

/** Verify a presented token against a stored Argon2 hash. */
export async function verifyTokenAgainstHash(presented: string, hash: string): Promise<boolean> {
  return verifyPassword(hash, presented);
}
