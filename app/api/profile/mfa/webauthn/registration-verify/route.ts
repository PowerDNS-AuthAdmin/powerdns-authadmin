/**
 * app/api/profile/mfa/webauthn/registration-verify/route.ts
 *
 * POST - finish a WebAuthn registration ceremony. Redeems the challenge
 * token from the temp-reveal-store, runs `verifyRegistrationResponse`,
 * persists the resulting credential into `users.webauthn_credentials`,
 * and audits.
 *
 * The challenge token is single-use; a wrong response burns it and the
 * client has to start over (mirrors the TOTP enrol-confirm pattern -
 * see app/api/profile/mfa/totp/route.ts).
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { assertBootstrapAdminMutable } from "@/lib/auth/bootstrap-admin";
import { redeem } from "@/lib/auth/temp-reveal-store";
import { getWebauthnConfig } from "@/lib/auth/webauthn";
import { verifyRegistration } from "@/lib/auth/webauthn/registration";
import { db } from "@/lib/db";
import { addCredential, listCredentials } from "@/lib/db/repositories/webauthn";
import { env } from "@/lib/env";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { registrationVerifySchema } from "@/lib/validators/webauthn";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    const { user } = await requireUser({ skipComplianceGate: true });
    await requireCsrf(request);
    assertBootstrapAdminMutable(user.email);

    let input;
    try {
      input = registrationVerifySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const revealed = await redeem({ token: input.challengeToken, actorId: user.id });
    if (!revealed) {
      throw new NotFoundError("Enrolment challenge unknown, already used, or expired.");
    }

    const config = await getWebauthnConfig();
    const result = await verifyRegistration({
      config,
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: revealed.plaintext,
      nickname: input.nickname,
    });
    if (!result.ok) {
      throw new ValidationError(`Could not verify the passkey: ${result.reason}.`);
    }

    // The challenge token is single-use so the credential id is the only
    // remaining replay surface - `addCredential` refuses duplicates.
    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const existing = await listCredentials(user.id, tx);
      if (existing.some((c) => c.id === result.credential.id)) {
        throw new ValidationError("This passkey is already enrolled on your account.");
      }
      await addCredential(user.id, result.credential, tx);
      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.mfa.webauthn.enrolled",
          resource: { type: "user", id: user.id },
          after: {
            credentialId: result.credential.id,
            nickname: result.credential.nickname,
            transports: result.credential.transports ?? [],
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({
      ok: true,
      credential: {
        id: result.credential.id,
        nickname: result.credential.nickname,
        transports: result.credential.transports ?? [],
        createdAt: result.credential.createdAt,
      },
    });
  } catch (err) {
    return errorResponse(err, "profile.mfa.webauthn.registration-verify.error");
  }
}
