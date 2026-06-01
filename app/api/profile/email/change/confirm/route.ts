/**
 * app/api/profile/email/change/confirm/route.ts
 *
 * POST { token } - finalize an email change. The token was minted by
 * `/api/profile/email/change` and carries `{userId, email=NEW}`.
 *
 * Safety analysis (why this is OK to share the `pde_` token shape
 * with the verify route):
 *
 *   1. **Cross-redeem verify-token-here**: an attacker who steals an
 *      email-verify token (its `payload.email` equals the user's
 *      CURRENT email) cannot use it to change the email - this route
 *      rejects when `payload.email === user.email` (no-op).
 *
 *   2. **Cross-redeem change-token-at-verify**: an attacker who
 *      steals a change-token (`payload.email` = NEW email) cannot
 *      verify the account - the verify route rejects when
 *      `payload.email !== user.email`.
 *
 *   3. **Replay**: after a successful swap, `user.email` becomes the
 *      token's `payload.email`. A second redemption sees them equal
 *      and bails with "no change requested." Single-use without
 *      needing a dedicated nonce store.
 *
 *   4. **Cross-user theft**: token is bound to userId in its
 *      payload; we require the authenticated caller to be that user.
 *      The route is gated by `requireUser()` and refuses if
 *      `payload.userId !== auth user.id`.
 *
 *   5. **Uniqueness race**: another user could grab the email
 *      between mint and confirm. We re-check at confirm time and
 *      bail with 409 if so.
 *
 * After swap, all of the user's sessions are revoked (mirroring
 * password-reset behavior) so an attacker who somehow held both a
 * session and a confirm-token can't keep the session under the new
 * email.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { verifyVerifyToken } from "@/lib/auth/email-verification-token";
import { db } from "@/lib/db";
import { findUserByEmail, findUserById, updateUser } from "@/lib/db/repositories/users";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { changeEmailConfirmSchema } from "@/lib/validators/users";
import { env } from "@/lib/env";
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    let input;
    try {
      input = changeEmailConfirmSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const hdrs = await headers();

    const result = verifyVerifyToken({ token: input.token, secret: env.APP_SECRET_KEY });
    if (!result.ok) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.change.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: result.reason },
        request: getRequestContext(hdrs),
      });
      throw new ValidationError(`Invalid token: ${result.reason}.`);
    }

    if (result.payload.userId !== user.id) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.change.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "wrong-user" },
        request: getRequestContext(hdrs),
      });
      throw new ForbiddenError("This token is not for the current account.");
    }

    const fresh = await findUserById(user.id);
    if (!fresh) throw new UnauthorizedError();

    const newEmail = result.payload.email.toLowerCase();

    // Rejects:
    //  - replay after successful swap (user.email is now newEmail)
    //  - cross-redeem of a verify-token (its email == user.email)
    if (newEmail === fresh.email.toLowerCase()) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.change.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "no-change-requested" },
        request: getRequestContext(hdrs),
      });
      throw new ValidationError("This email change has already been completed.");
    }

    // Uniqueness race - another user grabbed the email between mint
    // and confirm.
    const conflicting = await findUserByEmail(newEmail);
    if (conflicting && conflicting.id !== user.id) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.email.change.invalid",
        resource: { type: "user", id: user.id },
        after: { reason: "email-taken", attemptedEmail: newEmail },
        request: getRequestContext(hdrs),
      });
      throw new ConflictError("That email is already in use.");
    }

    const oldEmail = fresh.email;
    const newEmailValue = await db.transaction(async (tx) => {
      await updateUser(
        user.id,
        {
          email: newEmail,
          emailVerifiedAt: new Date(),
        },
        tx,
      );

      // Revoke everything (including the current session). The user
      // will sign back in with the new email. Mirrors the password-
      // reset behavior - credential equivalence is changing.
      const revoked = await revokeSessionsForUser(user.id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.email.change.completed",
          resource: { type: "user", id: user.id },
          before: { email: oldEmail },
          after: { email: newEmail, revokedSessions: revoked },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return newEmail;
    });

    return Response.json({ ok: true, email: newEmailValue });
  } catch (err) {
    return errorResponse(err, "profile.email.change.confirm.route.error");
  }
}
