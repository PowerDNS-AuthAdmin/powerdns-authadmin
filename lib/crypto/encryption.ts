/**
 * lib/crypto/encryption.ts
 *
 * Authenticated symmetric encryption for at-rest secrets: PDNS API keys, OAuth
 * client secrets, TOTP secrets, the session cookie payload - anything that
 * lives in the DB or a cookie and contains data we don't want a DB read or a
 * cookie-jar dump to disclose.
 *
 * Algorithm: AES-256-GCM. 12-byte random IV per encrypt. The output is a
 * versioned envelope so we can rotate keys or upgrade algorithms without a
 * flag-day migration:
 *
 *   v1:<base64url(iv)>:<base64url(ciphertext)>:<base64url(authTag)>
 *
 * Key: derived from `env.APP_ENCRYPTION_KEY` via HKDF-SHA-256 with a fixed
 * application salt. HKDF lets us derive separate subkeys later (e.g., one for
 * cookie encryption, one for DB column encryption) from the same operator
 * secret without storing two values.
 */

import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

/** Envelope format version. Bump when the algorithm or layout changes. */
const VERSION = "v1";

/** Application-wide salt for HKDF. Public; not a secret. */
const HKDF_SALT = Buffer.from("powerdns-authadmin/v1", "utf8");

/**
 * Derive a 32-byte subkey for a named usage. Different usages get different
 * keys, so a hypothetical disclosure of one subkey doesn't help an attacker
 * with another (defense in depth - the master key is still the secret).
 *
 * @param usage stable string identifying the subkey, e.g. "session-cookie".
 */
function deriveKey(usage: string): Buffer {
  const master = Buffer.from(env.APP_ENCRYPTION_KEY, "base64");
  if (master.length < 32) {
    throw new Error(
      "APP_ENCRYPTION_KEY must decode to at least 32 bytes (generate with: openssl rand -base64 32).",
    );
  }
  return Buffer.from(hkdfSync("sha256", master, HKDF_SALT, usage, 32));
}

/**
 * Encrypt a string. The output is opaque and includes the IV and auth tag.
 * Re-encrypting the same plaintext twice produces different ciphertexts (good).
 */
export function encrypt(plaintext: string, usage = "default"): string {
  const key = deriveKey(usage);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(":");
}

/**
 * Decrypt an envelope produced by `encrypt`. Throws if the envelope is
 * malformed, the version isn't supported, or the auth tag doesn't verify
 * (which means the ciphertext was tampered with - fail loudly).
 */
export function decrypt(envelope: string, usage = "default"): string {
  const parts = envelope.split(":");
  if (parts.length !== 4) {
    throw new Error("Encryption envelope has wrong shape.");
  }
  // After the length check, indices 0..3 are guaranteed defined; the
  // noUncheckedIndexedAccess flag wants us to narrow.
  const [version, ivB64, ctB64, tagB64] = parts as [string, string, string, string];
  if (version !== VERSION) {
    throw new Error(`Unsupported envelope version: ${version}`);
  }

  const key = deriveKey(usage);
  const iv = Buffer.from(ivB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");
  const authTag = Buffer.from(tagB64, "base64url");

  // Node's GCM decipher accepts any auth tag length ≥ 4 bytes by default,
  // which would silently downgrade authentication strength from 2^-128 to
  // 2^-32 for a truncated tag. Reject anything other than the standard
  // 16-byte (128-bit) tag we write on encrypt, and pass authTagLength as
  // defence-in-depth so Node never sees a shorter tag even if a caller
  // somehow bypasses this check.
  if (iv.length !== 12) {
    throw new Error("Encryption envelope has invalid IV length.");
  }
  if (authTag.length !== 16) {
    throw new Error("Encryption envelope has invalid auth tag length.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/** True if a value looks like one of our envelopes - useful for migrations. */
export function looksLikeEnvelope(value: string): boolean {
  return /^v\d+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(value);
}
