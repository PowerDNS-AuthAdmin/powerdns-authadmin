/**
 * lib/auth/email-verification-token.ts
 *
 * HMAC-signed email-verification token. Same shape and rationale as
 * `password-reset-token.ts` but scoped to the email-verification
 * action via a distinct HKDF `info` label so the two token types
 * can't be cross-redeemed (a leaked password-reset token can't
 * complete an email verification, and vice versa).
 *
 * Wire shape: `pde_<base64url-payload>.<base64url-sig>` ("pde" =
 * "pdns-admin email"). Payload carries
 * `{ userId, email, nonce, issuedAt, expiresAt }`. The `email` is
 * pinned in the payload so a token minted for one address can't be
 * used to verify a different address even if the user record was
 * edited between mint and redeem.
 *
 * Single-use is enforced by comparing `payload.issuedAt` to the
 * user's current `emailVerifiedAt` at redeem time — once verified,
 * any stale tokens are useless. A re-verify (operator changed
 * email, wants to re-confirm) would null out the column first, then
 * accept new tokens.
 *
 * Pure module — no DB, no HTTP, no env import.
 */

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIX = "pde_";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface VerifyTokenPayload {
  userId: string;
  /** Email the verification is bound to. Compared at redeem time. */
  email: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MintInput {
  userId: string;
  email: string;
  secret: string;
  ttlMs?: number;
  now?: () => number;
}

export function mintVerifyToken(input: MintInput): {
  token: string;
  payload: VerifyTokenPayload;
} {
  const now = input.now ? input.now() : Date.now();
  const ttl = input.ttlMs ?? DEFAULT_TTL_MS;
  const payload: VerifyTokenPayload = {
    userId: input.userId,
    email: input.email,
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
  | { ok: true; payload: VerifyTokenPayload }
  | { ok: false; reason: "shape" | "signature" | "expired" | "json" };

export interface VerifyInput {
  token: string;
  secret: string;
  now?: () => number;
}

export function verifyVerifyToken(input: VerifyInput): VerifyResult {
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

  let payload: VerifyTokenPayload;
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
  // Different `info` label than password-reset so a password-reset
  // key can't sign a valid email-verification token. Versioned so
  // format changes can rotate.
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from("email-verify-v1", "utf8"),
    32,
  );
  return createHmac("sha256", Buffer.from(derived)).update(payloadB64).digest("base64url");
}

function constantTimeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function isPayload(v: unknown): v is VerifyTokenPayload {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["userId"] === "string" &&
    typeof o["email"] === "string" &&
    typeof o["nonce"] === "string" &&
    typeof o["issuedAt"] === "number" &&
    typeof o["expiresAt"] === "number"
  );
}
