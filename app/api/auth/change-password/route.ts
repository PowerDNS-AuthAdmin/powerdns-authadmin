/**
 * app/api/auth/change-password/route.ts
 *
 * POST — change the signed-in user's password. Verifies the current password
 * (constant-time on the no-password / SSO-only path), hashes the new one
 * with current Argon2 params, clears the `mustChangePassword` flag, and
 * audit-logs the action.
 *
 * Does NOT revoke other sessions — that's a separate action on /profile so
 * the operator decides. The current session stays valid.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { verifyTurnstile } from "@/lib/auth/captcha";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { sensitiveLimiter } from "@/lib/auth/rate-limit";
import { changePasswordSchema } from "@/lib/validators/users";
import { findUserById, updateUser } from "@/lib/db/repositories/users";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { RateLimitedError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    let input;
    try {
      input = changePasswordSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const hdrs = await headers();

    // Captcha gate (S-4 follow-up). Same shape as the login route: only
    // enforced when TURNSTILE_SECRET_KEY is set so dev without keys still
    // works. Verified BEFORE the rate-limiter so a bot stream can't burn
    // the per-user budget, and BEFORE the password hasher so a missing /
    // invalid token never reaches Argon2. Even though the route is
    // authenticated + CSRF-checked + rate-limited + current-password-
    // gated, the captcha adds a meaningful layer against XSS-stolen
    // session/CSRF-pair scenarios where an attacker can drive a real
    // browser but a human isn't watching.
    if (env.TURNSTILE_SECRET_KEY) {
      if (!input.captchaToken) {
        await appendAudit({
          actor: { type: "user", id: user.id },
          action: "auth.password.changed",
          resource: { type: "user", id: user.id },
          after: { ok: false, reason: "captcha-missing" },
          request: {
            ip: clientIp(hdrs),
            userAgent: hdrs.get("user-agent"),
            requestId: getRequestId(hdrs),
          },
        });
        throw new ValidationError("Captcha required.", {
          fieldErrors: { captchaToken: ["Captcha required."] },
        });
      }
      const captcha = await verifyTurnstile({
        secret: env.TURNSTILE_SECRET_KEY,
        token: input.captchaToken,
        remoteIp: clientIp(hdrs),
      });
      if (!captcha.ok) {
        await appendAudit({
          actor: { type: "user", id: user.id },
          action: "auth.password.changed",
          resource: { type: "user", id: user.id },
          after: { ok: false, reason: "captcha-failed", providerReasons: captcha.reasons },
          request: {
            ip: clientIp(hdrs),
            userAgent: hdrs.get("user-agent"),
            requestId: getRequestId(hdrs),
          },
        });
        logger.warn(
          { providerReasons: captcha.reasons, requestId: getRequestId(hdrs) },
          "auth.change-password.captcha-failed",
        );
        throw new ValidationError("Captcha verification failed.", {
          fieldErrors: { captchaToken: ["Captcha verification failed. Try again."] },
        });
      }
    }

    // Rate-limit per user to make brute-force / harvested-session abuse loud.
    const limit = await sensitiveLimiter.takeShared(`change-password:${user.id}`);
    if (!limit.allowed) {
      throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const fresh = await findUserById(user.id);
    if (!fresh) throw new UnauthorizedError();
    if (!fresh.passwordHash) {
      throw new ValidationError(
        "This account uses single sign-on. Change your password with your identity provider.",
      );
    }

    const ok = await verifyPassword(fresh.passwordHash, input.currentPassword);
    if (!ok) {
      throw new ValidationError("Current password is incorrect.");
    }

    const newHash = await hashPassword(input.newPassword);
    await db.transaction(async (tx) => {
      await updateUser(
        user.id,
        {
          passwordHash: newHash,
          mustChangePassword: false,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.password.changed",
          resource: { type: "user", id: user.id },
          request: {
            ip: clientIp(hdrs),
            userAgent: hdrs.get("user-agent"),
            requestId: getRequestId(hdrs),
          },
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "auth.change-password.route.error");
  }
}

function clientIp(hdrs: Headers): string | null {
  return getClientIp(hdrs);
}
