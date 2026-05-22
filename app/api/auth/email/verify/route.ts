/**
 * app/api/auth/email/verify/route.ts
 *
 * POST { token } — consume an email-verification token and set
 * `email_verified_at` on the user row. Three guard checks beyond
 * basic signature+expiry:
 *   1. The token's `userId` must match the authenticated user — we
 *      don't allow Alice to redeem a token minted for Bob.
 *   2. The token's `email` must match the user's current email — if
 *      the admin edited the email between mint and redeem, the token
 *      is invalid (it was attesting the OLD address).
 *   3. The user must not already be verified — re-verifying is a
 *      404-like no-op rather than a double-write.
 *
 * The redemption check (`emailVerifiedAt > token.issuedAt` → reject)
 * makes the token single-use without a consumed-tokens table.
 *
 * CSRF + rate-limit on the request — both the verify page form and
 * this endpoint live on the authenticated app.
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { sensitiveLimiter } from "@/lib/auth/rate-limit";
import { verifyVerifyToken } from "@/lib/auth/email-verification-token";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";

const bodySchema = z.object({
  token: z.string().min(8).max(2048),
});

const GENERIC_REJECT = "Invalid or expired verification link.";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    const limit = sensitiveLimiter.take(`verify:${user.id}`);
    if (!limit.allowed) {
      return Response.json(
        {
          error: "Too many requests.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429, headers: { "Cache-Control": "no-store" } },
      );
    }

    const hdrs = await headers();
    const reqInfo = getRequestContext(hdrs);

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

    const verify = verifyVerifyToken({
      token: body.token,
      secret: env.APP_SECRET_KEY,
    });
    if (!verify.ok) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: verify.reason },
        request: reqInfo,
      });
      return Response.json({ error: GENERIC_REJECT }, { status: 400 });
    }

    // Guard 1: token addressed to this user.
    if (verify.payload.userId !== user.id) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.verify.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "user-mismatch" },
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
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "auth.email.verify.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
