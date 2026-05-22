/**
 * app/api/auth/mfa/totp/route.ts
 *
 * POST { challengeToken, code } — complete the MFA step after a
 * successful password verification. Redeems the challenge token
 * (single-use, 5-min TTL, minted by /api/auth/login when the user
 * has TOTP enrolled), verifies the 6-digit code, and starts the
 * session.
 *
 * The challenge token is the bearer credential here — there's no
 * session cookie yet. Single-use semantics from `temp-reveal-store`
 * prevent replay; the 5-min TTL bounds the window if the operator
 * walked away after entering their password. Wrong-code attempts
 * burn the token (same as the TOTP enrollment confirm path) so
 * brute-forcing the 6-digit code is impossible without a fresh
 * password verification.
 *
 * Rate-limited by IP via the existing `loginLimiter`.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { startSession } from "@/lib/auth/session";
import { redeem as redeemRevealToken } from "@/lib/auth/temp-reveal-store";
import { verifyTotp } from "@/lib/auth/totp";
import { decrypt } from "@/lib/crypto/encryption";
import { findUserById } from "@/lib/db/repositories/users";
import { logger } from "@/lib/logger";

const bodySchema = z.object({
  challengeToken: z.string().min(20).max(200),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits."),
});

function jsonError(status: number, message: string, extra: Record<string, unknown> = {}) {
  return Response.json(
    { error: message, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);
  const userAgent = hdrs.get("user-agent");

  {
    const limit = loginLimiter.take(`mfa:${ip ?? "unknown"}`);
    if (!limit.allowed) {
      return jsonError(429, "Too many MFA attempts.", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
  }

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      return jsonError(400, "Invalid request body.");
    }
    return jsonError(400, "Invalid request body.");
  }

  const revealed = redeemRevealToken({
    token: body.challengeToken,
    actorId: "_mfa-pending",
  });
  if (!revealed) {
    await appendAudit({
      actor: { type: "user", id: null },
      action: "auth.login.failure",
      resource: { type: "auth", id: "_mfa" },
      after: { reason: "mfa-token-invalid" },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });
    return jsonError(400, "Invalid or expired MFA challenge.");
  }
  const userId = revealed.plaintext;

  const user = await findUserById(userId);
  if (!user || user.disabledAt || !user.totpSecretEncrypted) {
    // The user disappeared / got disabled / had MFA removed between
    // password-step and code-step. Fail closed; the token was
    // already burned by the redeem above so the operator restarts
    // from /login.
    await appendAudit({
      actor: { type: "user", id: userId },
      action: "auth.login.failure",
      resource: { type: "auth", id: "_mfa" },
      after: { reason: "user-state-changed-mid-flow" },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });
    return jsonError(400, "Invalid or expired MFA challenge.");
  }

  const secret = decrypt(user.totpSecretEncrypted, "totp-secret");
  if (!verifyTotp(secret, body.code)) {
    // Wrong code; the challenge token was already burned by the
    // redeem above. Operator has to re-enter password to get a new
    // challenge. That's the brute-force mitigation: one code attempt
    // per password attempt.
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "auth.login.failure",
      resource: { type: "user", id: user.id },
      after: { reason: "mfa-code-wrong" },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });
    return jsonError(401, "Code didn't verify. Sign in again.");
  }

  await startSession({ userId: user.id, ip, userAgent });

  await appendAudit({
    actor: { type: "user", id: user.id },
    action: "auth.login.success",
    resource: { type: "user", id: user.id },
    after: { mfaCompleted: true },
    request: { ip, userAgent, requestId: getRequestId(hdrs) },
  });
  logger.info({ userId: user.id, source: "local", mfa: "totp" }, "auth.login.mfa.success");

  return Response.json(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mustChangePassword: user.mustChangePassword,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
