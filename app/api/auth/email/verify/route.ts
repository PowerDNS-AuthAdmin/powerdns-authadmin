/**
 * app/api/auth/email/verify/route.ts
 *
 * POST { token } — consume an email-verification token and set
 * `email_verified_at` on the user row.
 *
 * UNAUTHENTICATED by design: the signed token itself proves email
 * ownership, so requiring a session would make the flow unreachable
 * for signup users — they're blocked from logging in until verified
 * (login returns 403 for unverified local accounts when
 * SIGNUP_ENABLED), so they never have a session to satisfy a
 * `requireUser()` gate. This mirrors the password-reset route, which
 * is likewise token-only. The user is resolved from the token's
 * `userId`, not from a session.
 *
 * Guards beyond signature + expiry:
 *   1. The user the token names must exist and not be disabled.
 *   2. The token's `email` must match the user's current email — if
 *      the email was edited between mint and redeem, the token is
 *      invalid (it was attesting the OLD address).
 *   3. The user must not already be verified by a token at least as
 *      new as this one. The redemption check
 *      (`emailVerifiedAt > token.issuedAt` → reject) makes the token
 *      single-use without a consumed-tokens table.
 *
 * Defenses on the open endpoint: per-IP rate limit (reuses the login
 * bucket like reset-password), constant-time HMAC verification inside
 * `verifyVerifyToken`, and the token's own expiry. CSRF is still
 * enforced when a session cookie is present (logged-in re-verify UX),
 * and is a safe no-op for the logged-out signup path.
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestContext } from "@/lib/client-ip";
import { requireCsrf } from "@/lib/auth/csrf";
import { loginLimiter } from "@/lib/auth/rate-limit";
import { verifyVerifyToken } from "@/lib/auth/email-verification-token";
import { findUserById } from "@/lib/db/repositories/users";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";

const bodySchema = z.object({
  token: z.string().min(8).max(2048),
});

const GENERIC_REJECT = "Invalid or expired verification link.";

export async function POST(request: Request): Promise<Response> {
  const hdrs = await headers();
  const reqInfo = getRequestContext(hdrs);
  const ip = getClientIp(hdrs);

  {
    const limit = await loginLimiter.takeShared(`verify:${ip ?? "unknown"}`);
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
    // CSRF rejection still gets the generic message — don't leak that
    // the token itself was valid.
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

  try {
    const verify = verifyVerifyToken({
      token: body.token,
      secret: env.APP_SECRET_KEY,
    });
    if (!verify.ok) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: null },
        after: { reason: verify.reason },
        request: reqInfo,
      });
      return Response.json({ error: GENERIC_REJECT }, { status: 400 });
    }

    const user = await findUserById(verify.payload.userId);
    // Guard 1: token names an existing, enabled user.
    if (!user || user.disabledAt) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: verify.payload.userId },
        after: { reason: "user-missing-or-disabled" },
        request: reqInfo,
      });
      return Response.json({ error: GENERIC_REJECT }, { status: 400 });
    }

    // Guard 2: email is still the one the token attests.
    if (verify.payload.email !== user.email) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "email-mismatch" },
        request: reqInfo,
      });
      return Response.json({ error: GENERIC_REJECT }, { status: 400 });
    }

    // Guard 3: not already verified. Single-use via timestamp
    // comparison — once verified, any earlier-minted token is stale.
    if (user.emailVerifiedAt && user.emailVerifiedAt.getTime() > verify.payload.issuedAt) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "single-use-already-spent" },
        request: reqInfo,
      });
      return Response.json({ error: GENERIC_REJECT }, { status: 400 });
    }

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));

    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "auth.email.verify.completed",
      resource: { type: "user", id: user.id },
      after: { email: user.email },
      request: reqInfo,
    });
    logger.info({ userId: user.id }, "auth.email.verify.completed");

    return Response.json(
      { ok: true, message: "Email verified." },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "auth.email.verify.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
