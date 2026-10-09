/**
 * app/api/auth/email/send-verification/route.ts
 *
 * POST - mint a `pde_…` email-verification token for the
 * authenticated user and record the link in the audit log. Until
 * transactional email lands, the audit row's `after.url` is where
 * the operator finds the link to share with the user out-of-band
 * (mirrors the password-reset flow).
 *
 * Idempotent w.r.t. already-verified accounts: returns a 409 with
 * an operator-friendly message instead of minting a useless token.
 *
 * Permission: authenticated user (sends a token for themselves).
 * Rate-limited by user-id via the existing sensitive-action bucket
 * to prevent a logged-in attacker spamming the audit log.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { mintVerifyToken } from "@/lib/auth/email-verification-token";
import { sensitiveLimiter } from "@/lib/auth/rate-limit";
import { sendEmail } from "@/lib/email/send";
import { verifyEmailMessage } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    if (user.emailVerifiedAt) {
      throw new ConflictError("Email is already verified.");
    }

    const limit = await sensitiveLimiter.takeShared(`verify:${user.id}`);
    if (!limit.allowed) {
      return Response.json(
        {
          error: "Too many requests.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }

    const { token } = mintVerifyToken({
      userId: user.id,
      email: user.email,
      secret: env.APP_SECRET_KEY,
    });
    const verifyUrl = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
    const mail = await sendEmail({
      to: user.email,
      kind: "email-verification",
      ...verifyEmailMessage(verifyUrl),
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "auth.email.verify.sent",
      resource: { type: "user", id: user.id },
      after: {
        email: user.email,
        // Keep the tokenised link in the audit ONLY when SMTP is off, so an
        // operator can still share it out-of-band. When we emailed it, the
        // token stays out of the audit log.
        ...(mail.skipped ? { url: verifyUrl } : {}),
        delivered: mail.ok && !mail.skipped,
      },
      request: getRequestContext(hdrs),
    });
    if (mail.skipped) {
      logger.warn(
        { userId: user.id, verifyUrl },
        "auth.email.verify.sent - SMTP disabled; share this URL with the user out-of-band",
      );
    } else if (!mail.ok) {
      logger.error({ userId: user.id, error: mail.error }, "auth.email.verify.send-failed");
      return Response.json(
        { error: "Could not send the verification email. Check SMTP settings and try again." },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        ok: true,
        message: mail.skipped
          ? "Verification link recorded in the audit log. Your administrator will share it with you."
          : "Verification email sent. Check your inbox.",
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ConflictError) return Response.json({ error: err.message }, { status: 409 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "auth.email.send-verification.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
