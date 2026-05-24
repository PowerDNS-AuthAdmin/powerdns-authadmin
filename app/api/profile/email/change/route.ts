/**
 * app/api/profile/email/change/route.ts
 *
 * POST — start an email-change. Authenticated user submits the new
 * email + their current password (defense against session hijack).
 * Server mints an email-verification-style HMAC token bound to
 * (userId, newEmail) and records the confirm URL in the audit log.
 *
 * Why a token (not a direct swap): the new email must be proven
 * reachable. Until transactional email lands, the audit log carries
 * the URL — operators with audit.read share it with the user out-of-
 * band, mirroring the forgot-password flow. Once SMTP is wired up,
 * the route will additionally send the URL to the NEW email so the
 * confirm step is a click rather than a paste.
 *
 * The TOKEN type is the same `pde_…` shape used for email
 * verification — both flows are "prove control of an email." The
 * confirm endpoint reads `payload.email` as the NEW email when the
 * payload differs from the user's current email; otherwise it
 * behaves as plain verification. This explicit-email-in-payload
 * design means cross-redemption between the two flows is safe (see
 * the confirm route for the safety analysis).
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { mintVerifyToken } from "@/lib/auth/email-verification-token";
import { verifyPassword } from "@/lib/auth/password";
import { sensitiveLimiter } from "@/lib/auth/rate-limit";
import { sendEmail } from "@/lib/email/send";
import { emailChangeMessage } from "@/lib/email/templates";
import { findUserByEmail, findUserById } from "@/lib/db/repositories/users";
import { changeEmailRequestSchema } from "@/lib/validators/users";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    const limit = await sensitiveLimiter.takeShared(`change-email:${user.id}`);
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    let input;
    try {
      input = changeEmailRequestSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const newEmail = input.newEmail.toLowerCase();
    const fresh = await findUserById(user.id);
    if (!fresh) throw new UnauthorizedError();
    if (!fresh.passwordHash) {
      throw new ValidationError(
        "This account uses single sign-on. Change your email with your identity provider.",
      );
    }

    const ok = await verifyPassword(fresh.passwordHash, input.currentPassword);
    if (!ok) {
      throw new ValidationError("Current password is incorrect.", {
        fieldErrors: { currentPassword: ["Current password is incorrect."] },
      });
    }

    if (newEmail === fresh.email.toLowerCase()) {
      throw new ValidationError("New email is the same as your current email.", {
        fieldErrors: { newEmail: ["Enter a different email."] },
      });
    }

    // Refuse early when another user already owns the target email
    // so we don't mint a token that can never be redeemed (the
    // confirm route also re-checks; this is just nicer UX).
    const conflicting = await findUserByEmail(newEmail);
    if (conflicting && conflicting.id !== user.id) {
      throw new ValidationError("That email is already in use.", {
        fieldErrors: { newEmail: ["That email is already in use."] },
      });
    }

    const { token } = mintVerifyToken({
      userId: user.id,
      email: newEmail,
      secret: env.APP_SECRET_KEY,
    });
    const confirmUrl = `${env.APP_URL}/change-email?token=${encodeURIComponent(token)}`;
    // Confirmation goes to the NEW address — that's the ownership proof.
    const mail = await sendEmail({
      to: newEmail,
      kind: "email-change",
      ...emailChangeMessage(confirmUrl),
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "auth.email.change.requested",
      resource: { type: "user", id: user.id },
      after: {
        oldEmail: fresh.email,
        newEmail,
        // Out-of-band fallback only when SMTP is off; otherwise the token
        // stays out of the audit log.
        ...(mail.skipped ? { url: confirmUrl } : {}),
        delivered: mail.ok && !mail.skipped,
      },
      request: getRequestContext(hdrs),
    });

    if (mail.skipped) {
      logger.warn(
        { userId: user.id, newEmail, confirmUrl },
        "auth.email.change.requested — SMTP disabled; share this URL with the user out-of-band",
      );
    } else if (!mail.ok) {
      logger.error({ userId: user.id, error: mail.error }, "auth.email.change.send-failed");
      return Response.json(
        { error: "Could not send the confirmation email. Check SMTP settings and try again." },
        { status: 502 },
      );
    }

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "profile.email.change.route.error");
  }
}
