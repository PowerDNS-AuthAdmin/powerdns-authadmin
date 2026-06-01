/**
 * app/api/auth/forgot-password/route.ts
 *
 * POST { email } - initiate a password reset. Always returns 200 with
 * the same body regardless of whether the email matched a real user,
 * so the response is not an account-existence oracle. When the email
 * does match, mint a `pdr_…` signed token and:
 *   - Audit `auth.password.reset.requested` with the FULL reset URL
 *     in the `after.url` field. Until transactional email lands
 *     (future work), the audit log is the only place the operator
 *     can retrieve the link. SuperAdmins reviewing audit can hand it
 *     to the user out-of-band.
 *   - Log a warn line with the URL so it's visible in container
 *     stdout for ops debugging.
 *
 * Rate-limited by IP via the existing `loginLimiter` bucket (same
 * tier as login - this is a credential-related action).
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestContext } from "@/lib/client-ip";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { verifyTurnstile } from "@/lib/auth/captcha";
import { mintResetToken } from "@/lib/auth/password-reset-token";
import { sendEmail } from "@/lib/email/send";
import { passwordResetMessage } from "@/lib/email/templates";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { getAppSettings } from "@/lib/settings/app-settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";

const bodySchema = z.object({
  email: z.string().email().max(320),
  // Cloudflare Turnstile response token. Required by the route when
  // TURNSTILE_SECRET_KEY is configured; the schema accepts it
  // unconditionally so dev clients without the widget still validate.
  captchaToken: z.string().max(4096).optional(),
});

const GENERIC_OK = {
  ok: true,
  // Uniform message - never hints at whether the email exists.
  message:
    "If an account exists for that email, a password-reset link has been recorded in the audit log. Ask your administrator to share it with you.",
};

export async function POST(request: Request): Promise<Response> {
  const hdrs = await headers();
  const ip = getClientIp(hdrs);

  // Rate-limit by IP (same bucket family as login). Falls back to a shared
  // bucket when no IP is available so the limiter always applies.
  {
    const limit = await loginLimiter.takeShared(`forgot:${ip ?? "unknown"}`);
    if (!limit.allowed) {
      return Response.json(
        { error: "Too many requests.", retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  // Self-service reset can be turned off by an admin (allow_password_reset).
  // Stay opaque: return the same generic OK as a non-existent account so the
  // toggle state isn't observable from this endpoint.
  if (!(await getAppSettings()).allowPasswordReset) {
    return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
  }

  let body;
  try {
    body = bodySchema.parse(await request.json());
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError("Invalid input.", {
        fieldErrors: err.flatten().fieldErrors,
      });
    }
    return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
  }

  // Captcha gate (S-4 follow-up). Same shape as login + change-password:
  // enforced only when TURNSTILE_SECRET_KEY is set. Verified BEFORE the
  // DB lookup so a bot stream can't burn DB cycles to scrape timing.
  // Note: the response is still GENERIC_OK on captcha failure rather
  // than 4xx, so this endpoint stays account-existence opaque even when
  // captcha is misconfigured client-side - bots learn "captcha
  // rejected" only via the audit log, not the HTTP response.
  if (env.TURNSTILE_SECRET_KEY) {
    if (!body.captchaToken) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.password.reset.invalid",
        resource: { type: "auth", id: body.email.toLowerCase() },
        after: { reason: "captcha-missing" },
        request: getRequestContext(hdrs),
      });
      return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
    }
    const captcha = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: body.captchaToken,
      remoteIp: ip,
    });
    if (!captcha.ok) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.password.reset.invalid",
        resource: { type: "auth", id: body.email.toLowerCase() },
        after: { reason: "captcha-failed", providerReasons: captcha.reasons },
        request: getRequestContext(hdrs),
      });
      logger.warn({ providerReasons: captcha.reasons }, "auth.password.reset.captcha-failed");
      return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
    }
  }

  const user = await findUserByEmail(body.email);
  if (!user || user.disabledAt || !user.passwordHash) {
    // SSO-only users (no passwordHash) and disabled accounts get the
    // same opaque OK as missing emails - don't leak which.
    return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
  }

  const { token } = mintResetToken({
    userId: user.id,
    secret: env.APP_SECRET_KEY,
  });
  const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const mail = await sendEmail({
    to: user.email,
    kind: "password-reset",
    ...passwordResetMessage(resetUrl),
  });

  await appendAudit({
    actor: { type: "system", id: null },
    action: "auth.password.reset.requested",
    resource: { type: "user", id: user.id },
    after: {
      email: user.email,
      // Only record the tokenised link when SMTP is off (out-of-band
      // fallback). When emailed, the token stays out of the audit log.
      ...(mail.skipped ? { url: resetUrl } : {}),
      delivered: mail.ok && !mail.skipped,
    },
    request: getRequestContext(hdrs),
  });

  if (mail.skipped) {
    logger.warn(
      { userId: user.id, resetUrl },
      "auth.password.reset.requested - SMTP disabled; share this URL with the user out-of-band",
    );
  } else if (!mail.ok) {
    // Never surface send failures here - the response must stay opaque so it
    // can't be used to enumerate accounts. Log for the operator.
    logger.error({ userId: user.id, error: mail.error }, "auth.password.reset.send-failed");
  }

  return Response.json(GENERIC_OK, { headers: { "Cache-Control": "no-store" } });
}
