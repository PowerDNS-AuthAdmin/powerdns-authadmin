/**
 * app/api/profile/mfa/totp/route.ts
 *
 * Self-service TOTP enrollment and removal.
 *
 * POST   — start enrollment. Generates a fresh secret, stashes it in
 *          the temp-reveal-store keyed by a single-use token bound
 *          to the operator, and returns the `otpauth://` URI for the
 *          authenticator QR scan + the reveal token the operator's
 *          browser will send back in the confirm step. The secret is
 *          NOT persisted to the user row until the operator proves
 *          they scanned it correctly via the confirm step.
 *
 * PUT    — confirm enrollment. Body: { revealToken, code }. Redeems
 *          the secret from the reveal-store, verifies the 6-digit
 *          code, encrypts + writes to `user.totpSecretEncrypted`.
 *
 * DELETE — disable MFA. Clears the encrypted secret. Audit row notes
 *          the actor (in case the operator's account is later
 *          compromised, audit shows when MFA was removed).
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { mint, redeem } from "@/lib/auth/temp-reveal-store";
import { generateSecret, provisioningUri, verifyTotp } from "@/lib/auth/totp";
import { renderOtpAuthQrSvg } from "@/lib/auth/totp-qr";
import { encrypt } from "@/lib/crypto/encryption";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const ISSUER = "PowerDNS-AuthAdmin";

const confirmSchema = z.object({
  revealToken: z.string().min(20).max(200),
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits."),
});

/** POST — start enrollment. */
export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);
    if (user.totpSecretEncrypted) {
      throw new ConflictError(
        "TOTP is already enabled. Disable it first to re-enroll with a new authenticator.",
      );
    }

    const secret = generateSecret();
    const uri = provisioningUri({
      secret,
      accountName: user.email,
      issuer: ISSUER,
    });
    const qrSvg = await renderOtpAuthQrSvg(uri);
    // Stash the unencrypted secret in the reveal-store (in-memory,
    // 300s TTL, actor-bound). The encrypted version only lands in
    // the DB if the operator confirms with a valid code.
    const { token: revealToken, expiresInSec } = await mint({
      plaintext: secret,
      allowedActorId: user.id,
    });

    return Response.json(
      { ok: true, uri, qrSvg, secret, revealToken, expiresInSec },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "profile.mfa.totp.route.error");
  }
}

/** PUT — confirm with code. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);
    if (user.totpSecretEncrypted) {
      throw new ConflictError("TOTP is already enabled.");
    }

    let input;
    try {
      input = confirmSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const revealed = await redeem({ token: input.revealToken, actorId: user.id });
    if (!revealed) {
      throw new NotFoundError("Enrollment token unknown, already used, or expired.");
    }
    const secret = revealed.plaintext;

    if (!verifyTotp(secret, input.code)) {
      // The reveal-store entry was already burned by `redeem` — the
      // operator has to start over. That's intentional: it prevents
      // brute-forcing the 6-digit code against the same stashed
      // secret. The cost is one extra round-trip to start; the
      // benefit is the operator has six-million-to-one odds per
      // attempt with no retry budget.
      throw new ValidationError(
        "Code didn't verify. Start enrollment again from your authenticator app.",
      );
    }

    const encrypted = encrypt(secret, "totp-secret");
    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          totpSecretEncrypted: encrypted,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.mfa.enrolled",
          resource: { type: "user", id: user.id },
          after: { method: "totp" },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "profile.mfa.totp.route.error");
  }
}

/** DELETE — disable. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);
    if (!user.totpSecretEncrypted) {
      throw new NotFoundError("TOTP is not enabled on this account.");
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecretEncrypted: null, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.mfa.removed",
          resource: { type: "user", id: user.id },
          after: { method: "totp" },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "profile.mfa.totp.route.error");
  }
}
