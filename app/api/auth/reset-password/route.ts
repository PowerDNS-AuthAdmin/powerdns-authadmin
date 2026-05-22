/**
 * app/api/auth/reset-password/route.ts
 *
 * POST { token, password } — consume a signed reset token and set a
 * new password. CSRF-gated (the reset page sends the cookie); rate
 * limited by IP via the same login bucket.
 *
 * Single-use enforcement: the user's `passwordHashUpdatedAt` is
 * compared to the token's `issuedAt`. If the user's password has
 * been changed (or a previous reset link redeemed) since this token
 * was minted, the token is rejected. This makes the link
 * single-use without a consumed-tokens table.
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestContext } from "@/lib/client-ip";
import { requireCsrf } from "@/lib/auth/csrf";
import { hashPassword } from "@/lib/auth/password";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { verifyResetToken } from "@/lib/auth/password-reset-token";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { findUserById } from "@/lib/db/repositories/users";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";

const bodySchema = z.object({
  token: z.string().min(8).max(2048),
  password: z.string().min(12).max(1024),
});

const GENERIC_REJECT = "Invalid or expired reset link.";

export async function POST(request: Request): Promise<Response> {
  const hdrs = await headers();
  const reqInfo = getRequestContext(hdrs);
  const ip = getClientIp(hdrs);

  {
    const limit = loginLimiter.take(`reset:${ip ?? "unknown"}`);
    if (!limit.allowed) {
      return Response.json(
        { error: "Too many requests.", retryAfterSeconds: limit.retryAfterSeconds },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }
  }

  try {
    await requireCsrf(request);
  } catch {
    // CSRF rejection still gets the generic message — don't leak
    // that the token itself was valid.
    return Response.json({ error: GENERIC_REJECT }, { status: 400 });
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
    return Response.json({ error: GENERIC_REJECT }, { status: 400 });
  }

  const verify = verifyResetToken({ token: body.token, secret: env.APP_SECRET_KEY });
  if (!verify.ok) {
    await appendAudit({
      actor: { type: "system", id: null },
      action: "auth.password.reset.invalid",
      resource: { type: "user", id: null },
      after: { reason: verify.reason },
      request: reqInfo,
    });
    return Response.json({ error: GENERIC_REJECT }, { status: 400 });
  }

  const user = await findUserById(verify.payload.userId);
  if (!user || user.disabledAt) {
    await appendAudit({
      actor: { type: "system", id: null },
      action: "auth.password.reset.invalid",
      resource: { type: "user", id: verify.payload.userId },
      after: { reason: "user-missing-or-disabled" },
      request: reqInfo,
    });
    return Response.json({ error: GENERIC_REJECT }, { status: 400 });
  }

  // Single-use: reject tokens minted before the last password change.
  // Token was issued at `issuedAt`; row's `passwordHashUpdatedAt` is
  // the most recent password mutation. Strict greater-than so the
  // initial-mint case (issuedAt slightly after row's default
  // passwordHashUpdatedAt from `defaultNow()`) still works.
  if (user.passwordHashUpdatedAt.getTime() > verify.payload.issuedAt) {
    await appendAudit({
      actor: { type: "system", id: null },
      action: "auth.password.reset.invalid",
      resource: { type: "user", id: user.id },
      after: { reason: "single-use-already-spent" },
      request: reqInfo,
    });
    return Response.json({ error: GENERIC_REJECT }, { status: 400 });
  }

  const newHash = await hashPassword(body.password);
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        passwordHash: newHash,
        passwordHashUpdatedAt: new Date(),
        mustChangePassword: false,
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    // Revoke every existing session so an attacker who already had a
    // session for this user (the threat model for resets) gets kicked
    // out. The operator re-logs in via the normal flow.
    await revokeSessionsForUser(user.id, tx);

    await appendAudit(
      {
        actor: { type: "user", id: user.id },
        action: "auth.password.reset.completed",
        resource: { type: "user", id: user.id },
        after: { sessionsRevoked: true },
        request: reqInfo,
      },
      tx,
    );
  });

  logger.info({ userId: user.id }, "auth.password.reset.completed");

  return Response.json(
    { ok: true, message: "Password updated. Sign in with the new password." },
    { headers: { "Cache-Control": "no-store" } },
  );
}
