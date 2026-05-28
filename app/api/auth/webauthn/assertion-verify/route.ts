/**
 * app/api/auth/webauthn/assertion-verify/route.ts
 *
 * POST — finish a WebAuthn assertion and mint a session.
 *
 * Two modes share this route (controlled by `mode` in the body):
 *
 *   - `primary` — the user signed in with a passkey only (no password).
 *     The challenge token was minted by /assertion-options, bound to the
 *     constant actor `_webauthn-login-pending`.
 *
 *   - `second-factor` — the user already submitted a password to
 *     /api/auth/login and received a mfa-pending challenge token. We
 *     redeem THAT token (actor `_mfa-pending`, plaintext = userId) to
 *     learn which user this assertion is for, then verify against their
 *     stored credentials.
 *
 * On success: counter is bumped (replay defence), audit row written,
 * session started.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { requireCsrf } from "@/lib/auth/csrf";
import { redeem } from "@/lib/auth/temp-reveal-store";
import { startSession } from "@/lib/auth/session";
import { getWebauthnConfig } from "@/lib/auth/webauthn";
import { verifyAssertion } from "@/lib/auth/webauthn/assertion";
import { findUserById } from "@/lib/db/repositories/users";
import { findUserByCredentialId, touchCredential } from "@/lib/db/repositories/webauthn";
import { env } from "@/lib/env";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { assertionVerifySchema } from "@/lib/validators/webauthn";

const PRIMARY_CHALLENGE_ACTOR = "_webauthn-login-pending";
const MFA_CHALLENGE_ACTOR = "_mfa-pending";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    // Pre-session POST — no `requireUser`. We still expect CSRF because the
    // request originates from our SPA bearing the cookie pair (the temp
    // reveal-store doesn't validate origin and the assertion alone proves
    // the device, not the origin).
    await requireCsrf(request);

    let input;
    try {
      input = assertionVerifySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const hdrs = await headers();
    const ip = getClientIp(hdrs);
    const userAgent = hdrs.get("user-agent");

    // Both modes consume a WebAuthn challenge token minted by
    // /assertion-options (single-use, bound to PRIMARY_CHALLENGE_ACTOR).
    // The challenge value goes into the verifier to defeat replay.
    const challengeRedeem = await redeem({
      token: input.challengeToken,
      actorId: PRIMARY_CHALLENGE_ACTOR,
    });
    if (!challengeRedeem) {
      throw new NotFoundError("Sign-in challenge expired or already used.");
    }
    const expectedChallenge = challengeRedeem.plaintext;

    // Identify the user. Primary mode learns it from the credential id;
    // second-factor mode redeems the mfa-pending token issued by /api/auth/login.
    let userId: string;
    if (input.mode === "primary") {
      const credentialId = (input.response as { id?: unknown }).id;
      if (typeof credentialId !== "string" || credentialId.length === 0) {
        throw new ValidationError("Assertion missing credential id.");
      }
      const match = await findUserByCredentialId(credentialId);
      if (!match) {
        await appendAudit({
          actor: { type: "user", id: null },
          action: "auth.login.failure",
          resource: { type: "auth", id: credentialId },
          after: { reason: "webauthn-credential-unknown" },
          request: { ip, userAgent, requestId: getRequestId(hdrs) },
        });
        throw new NotFoundError("Sign-in failed.");
      }
      userId = match.user.id;
    } else {
      // The schema's `.refine` guarantees `mfaToken` is present.
      const mfaRedeem = await redeem({
        token: input.mfaToken!,
        actorId: MFA_CHALLENGE_ACTOR,
      });
      if (!mfaRedeem) {
        throw new NotFoundError("MFA challenge expired or already used.");
      }
      userId = mfaRedeem.plaintext;
    }

    const user = await findUserById(userId);
    if (!user || user.disabledAt) {
      throw new ForbiddenError("Account unavailable.");
    }

    const credentialId = (input.response as { id?: unknown }).id;
    if (typeof credentialId !== "string") {
      throw new ValidationError("Assertion missing credential id.");
    }
    const credentials = user.webauthnCredentials;
    const credential = credentials.find((c) => c.id === credentialId);
    if (!credential) {
      throw new NotFoundError("Credential not registered to this account.");
    }

    const config = await getWebauthnConfig();
    const result = await verifyAssertion({
      config,
      response: input.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      credential,
    });
    if (!result.ok) {
      await appendAudit({
        actor: { type: "user", id: user.id },
        action: "auth.login.failure",
        resource: { type: "user", id: user.id },
        after: { reason: `webauthn-${result.reason}`, mode: input.mode },
        request: { ip, userAgent, requestId: getRequestId(hdrs) },
      });
      throw new ValidationError("Sign-in failed.");
    }

    await touchCredential(user.id, credential.id, result.newCounter);
    await startSession({ userId: user.id, ip, userAgent });

    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "auth.login.success",
      resource: { type: "user", id: user.id },
      after: {
        method: input.mode === "primary" ? "webauthn-primary" : "webauthn-second-factor",
        credentialId: credential.id,
      },
      request: { ip, userAgent, requestId: getRequestId(hdrs) },
    });

    logger.info(
      { userId: user.id, mode: input.mode, credentialId: credential.id },
      "auth.webauthn.assertion.success",
    );

    return Response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        mustChangePassword: user.mustChangePassword,
      },
    });
  } catch (err) {
    return errorResponse(err, "auth.webauthn.assertion-verify.error");
  }
}
