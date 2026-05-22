/**
 * lib/auth/totp.ts
 *
 * Time-based one-time passwords per RFC 6238 (TOTP) atop RFC 4226
 * (HOTP). Implemented locally — about 60 lines of HMAC + bit
 * arithmetic — so we avoid taking a dep on `otplib` (which bundles
 * an algorithm registry + url parser + base32 helpers we don't need).
 *
 * Defaults follow what authenticator apps expect:
 *   - Algorithm: SHA1 (RFC default; all common apps support it)
 *   - Digits:    6
 *   - Step:      30 seconds
 *   - Window:    ±1 step (60-second clock-skew tolerance)
 *
 * Pure module — no DB, no HTTP. The caller provides the secret. Tests
 * stub `Date.now` directly.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface TotpOptions {
  /** Number of digits (default 6). */
  digits?: number;
  /** Time step in seconds (default 30). */
  stepSec?: number;
  /** Allowed skew in steps either side (default 1 → ±30s window). */
  window?: number;
  /** Override Date.now for tests. */
  now?: () => number;
}

/** Generate a new base32-encoded secret. 20 random bytes → 32 chars. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

/**
 * Build the `otpauth://` provisioning URI authenticator apps consume.
 * `accountName` is usually the user's email; `issuer` is the app name
 * shown in the operator's authenticator app (e.g. "PowerDNS-AuthAdmin").
 *
 * Per Google's spec: https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
export function provisioningUri(input: {
  secret: string;
  accountName: string;
  issuer: string;
  digits?: number;
  stepSec?: number;
}): string {
  const label = encodeURIComponent(`${input.issuer}:${input.accountName}`);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(input.digits ?? 6),
    period: String(input.stepSec ?? 30),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Compute the current TOTP code for `secret`. Useful for tests and
 * for the "show current code" diagnostic an operator might want
 * during enrollment QA.
 */
export function currentTotp(secret: string, opts: TotpOptions = {}): string {
  const step = opts.stepSec ?? 30;
  const now = opts.now ? opts.now() : Date.now();
  const counter = Math.floor(now / 1000 / step);
  return hotp(secret, counter, opts.digits ?? 6);
}

/**
 * Verify a presented code. Returns true when the code matches the
 * current step OR any step within ±`window`. The verification uses
 * `timingSafeEqual` on equal-length strings so a partial match can't
 * be detected by timing.
 */
export function verifyTotp(secret: string, presented: string, opts: TotpOptions = {}): boolean {
  const digits = opts.digits ?? 6;
  if (!/^\d+$/.test(presented) || presented.length !== digits) return false;

  const step = opts.stepSec ?? 30;
  const window = opts.window ?? 1;
  const now = opts.now ? opts.now() : Date.now();
  const counter = Math.floor(now / 1000 / step);

  const presentedBuf = Buffer.from(presented, "utf8");
  for (let i = -window; i <= window; i++) {
    const candidate = hotp(secret, counter + i, digits);
    const candidateBuf = Buffer.from(candidate, "utf8");
    if (
      candidateBuf.length === presentedBuf.length &&
      timingSafeEqual(candidateBuf, presentedBuf)
    ) {
      return true;
    }
  }
  return false;
}

// =============================================================================
// HOTP — the underlying construction (RFC 4226). Per-counter HMAC.
// =============================================================================

function hotp(secret: string, counter: number, digits: number): string {
  const key = base32Decode(secret);
  // Counter as 8-byte big-endian.
  const counterBuf = Buffer.alloc(8);
  // Bitwise ops on > 32-bit ints don't work in JS; use Number /
  // 2^32 trick to split into high/low halves.
  const high = Math.floor(counter / 0x100000000);
  const low = counter & 0xffffffff;
  counterBuf.writeUInt32BE(high, 0);
  counterBuf.writeUInt32BE(low >>> 0, 4);

  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  // Dynamic truncation per RFC 4226 §5.3.
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);

  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

// =============================================================================
// Base32 (RFC 4648) — authenticator apps speak base32, so do we.
// =============================================================================

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  // Strip whitespace + lowercase the input — many authenticators
  // emit lowercase or spaced base32 when sharing secrets.
  const clean = s.replace(/[\s=]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
