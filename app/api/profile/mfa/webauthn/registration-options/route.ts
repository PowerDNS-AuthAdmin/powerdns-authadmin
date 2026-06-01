/**
 * app/api/profile/mfa/webauthn/registration-options/route.ts
 *
 * POST - start a WebAuthn registration ceremony for the signed-in user.
 *
 * Mirrors the TOTP enrol-start pattern: we mint the ceremony challenge,
 * stash it in the temp-reveal-store keyed by a single-use token bound to
 * the user, and return the public options + that token to the browser.
 * The matching verify route (./registration-verify/route.ts) redeems the
 * token, runs the verify ceremony, and persists the credential.
 *
 * Skips the MFA-compliance gate (`skipComplianceGate: true`) because a
 * user who is forced to enrol MFA must be able to reach this endpoint to
 * satisfy the gate.
 */

import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { assertBootstrapAdminMutable } from "@/lib/auth/bootstrap-admin";
import { mint } from "@/lib/auth/temp-reveal-store";
import { getWebauthnConfig } from "@/lib/auth/webauthn";
import { startRegistration } from "@/lib/auth/webauthn/registration";
import { listCredentials } from "@/lib/db/repositories/webauthn";
import { env } from "@/lib/env";
import { ForbiddenError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    const { user } = await requireUser({ skipComplianceGate: true });
    await requireCsrf(request);
    assertBootstrapAdminMutable(user.email);

    const config = await getWebauthnConfig();
    const existing = await listCredentials(user.id);
    const { options, challenge } = await startRegistration({
      config,
      user: { id: user.id, email: user.email, name: user.name },
      existingCredentials: existing,
    });

    const { token: challengeToken, expiresInSec } = await mint({
      plaintext: challenge,
      allowedActorId: user.id,
    });

    return Response.json(
      { ok: true, options, challengeToken, expiresInSec },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "profile.mfa.webauthn.registration-options.error");
  }
}
