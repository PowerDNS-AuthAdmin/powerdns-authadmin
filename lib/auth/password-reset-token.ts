/**
 * lib/auth/password-reset-token.ts
 *
 * HMAC-signed, time-bounded, single-use password-reset token.
 *
 * Wire shape: `pdr_<base64url-payload>.<base64url-sig>`. The payload
 * carries `{ userId, nonce, expiresAt }`. The signature is
 * `HMAC-SHA256(payload, hkdf(APP_SECRET_KEY, "password-reset-v1"))`.
 *
 * Why HMAC-signed (not JWT / not opaque DB row):
 *   - **Self-contained**: no DB row to lose, no cleanup job for
 *     expired tokens. Verification is a constant string + one HMAC.
 *   - **Single-use enforcement via `lastChangedAt`**: the audit
 *     pipeline records the timestamp on every password change; when a
 *     token is redeemed the route bumps the user's password-update
 *     timestamp. The token's `issuedAt` is compared to the current
 *     `passwordHashUpdatedAt` on redemption - if the user changed
 *     their password (or used a previous reset link) since this token
 *     was minted, the token is rejected. Replay-safe without a
 *     consumed-tokens table.
 *   - **No JWT lib needed**: the payload shape is fixed, no third-
 *     party algorithm negotiation, no kid / alg vulnerabilities.
 *
 * Pure module - no DB, no HTTP, no env import. The caller supplies
 * the key. Tests can stub `Date.now` and the key with no plumbing.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "pdr_";
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface ResetTokenPayload {
  /** Subject user id (UUID). */
  userId: string;
  /** Random per-mint value so two consecutive mints differ. */
  nonce: string;
  /**
   * Issuance timestamp (ms epoch). Used both for expiry math AND for
   * the single-use invariant: the redeem path rejects tokens whose
   * `issuedAt` precedes the user's `passwordHashUpdatedAt`.
   */
  issuedAt: number;
  /** Expiry timestamp (ms epoch). Convenience - could be derived from
   *  issuedAt + TTL, but explicit lets the verifier check without
   *  knowing the TTL the issuer used. */
  expiresAt: number;
}

export interface MintInput {
  userId: string;
  /** Raw secret bytes - typically `process.env.APP_SECRET_KEY`. */
  secret: string;
  /** Override the default TTL (30 minutes) for test purposes. */
  ttlMs?: number;
  /** Override Date.now for tests. */
  now?: () => number;
}

export function mintResetToken(input: MintInput): {
  token: string;
  payload: ResetTokenPayload;
} {
  const now = input.now ? input.now() : Date.now();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const payload: ResetTokenPayload = {
    userId: input.userId,
    nonce: randomBytes(12).toString("base64url"),
    issuedAt: now,
    expiresAt: now + ttl,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = sign(payloadB64, input.secret);
  return { token: `${PREFIX}${payloadB64}.${sig}`, payload };
}

export type VerifyResult =
  | { ok: true; payload: ResetTokenPayload }
  | { ok: false; reason: "shape" | "signature" | "expired" | "json" };

export interface VerifyInput {
  token: string;
  secret: string;
  /** Override Date.now for tests. */
  now?: () => number;
}

/**
 * Validate the token's shape, signature, and expiry. Does NOT check
 * single-use freshness - that requires the user's
 * `passwordHashUpdatedAt` field which is a DB read; the route layer
 * does that check after `verifyResetToken` returns ok.
 *
 * All failure modes return a discriminated reason so the caller can
 * log differently without leaking which case to the user. The HTTP
 * layer collapses every failure into a single "Invalid or expired"
 * user-visible message.
 */
export function verifyResetToken(input: VerifyInput): VerifyResult {
  if (!input.token.startsWith(PREFIX)) return { ok: false, reason: "shape" };
  const body = input.token.slice(PREFIX.length);
  const dotIdx = body.lastIndexOf(".");
  if (dotIdx < 0) return { ok: false, reason: "shape" };
  const payloadB64 = body.slice(0, dotIdx);
  const sig = body.slice(dotIdx + 1);
  if (payloadB64.length === 0 || sig.length === 0) {
    return { ok: false, reason: "shape" };
  }

  const expected = sign(payloadB64, input.secret);
  if (!constantTimeEqualString(expected, sig)) {
    return { ok: false, reason: "signature" };
  }

  let payload: ResetTokenPayload;
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (!isPayload(parsed)) return { ok: false, reason: "json" };
    payload = parsed;
  } catch {
    return { ok: false, reason: "json" };
  }

  const now = input.now ? input.now() : Date.now();
  if (payload.expiresAt <= now) return { ok: false, reason: "expired" };

  return { ok: true, payload };
}

function sign(payloadB64: string, secret: string): string {
  // Derive a subkey via HKDF-SHA256 so a leaked password-reset key
  // can't be confused with the session-encryption key. The `info`
  // string is the version label - if the format ever changes,
  // rotate the label so old tokens become invalid.
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from("password-reset-v1", "utf8"),
    32,
  );
  return createHmac("sha256", Buffer.from(derived)).update(payloadB64).digest("base64url");
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isPayload(v: unknown): v is ResetTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["userId"] === "string" &&
    typeof o["nonce"] === "string" &&
    typeof o["issuedAt"] === "number" &&
    typeof o["expiresAt"] === "number"
  );
}
