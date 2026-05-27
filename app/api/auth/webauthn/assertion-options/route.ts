/**
 * app/api/auth/webauthn/assertion-options/route.ts
 *
 * POST — start an unauthenticated WebAuthn assertion. Body is optional and
 * may include `{ email }` to scope `allowCredentials` to that user's set;
 * omitting the body is the discoverable-credential (passkey-first,
 * username-less) flow — the platform picks the credential from the user's
 * device-local set bound to our RP.
 *
 * Returns `{ options, challengeToken }`. The token is bound to the constant
 * actor `_webauthn-login-pending` and redeemed by /api/auth/webauthn/
 * assertion-verify on the next round-trip. Five-minute TTL.
 *
 * Deliberately does NOT leak whether `email` resolves to a user — when
 * `email` is supplied but unknown we return a *valid-looking* options
 * payload with an empty allowCredentials list, identical in shape to the
 * "known user but no passkeys" case. An attacker can't enumerate accounts
 * from the response.
 */

import { mint } from "@/lib/auth/temp-reveal-store";
import { getWebauthnConfig } from "@/lib/auth/webauthn";
import { startAssertion } from "@/lib/auth/webauthn/assertion";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { listCredentials } from "@/lib/db/repositories/webauthn";
import { env } from "@/lib/env";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { assertionOptionsSchema } from "@/lib/validators/webauthn";
import { ZodError } from "zod";

const CHALLENGE_ACTOR = "_webauthn-login-pending";

export async function POST(request: Request): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    let input: { email?: string } = {};
    try {
      const raw: unknown = await request.json().catch(() => ({}));
      input = assertionOptionsSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const config = await getWebauthnConfig();

    // Optional account scoping. We deliberately do not signal "unknown
    // user" through the response shape — enumeration defense.
    let allowCredentials: Awaited<ReturnType<typeof listCredentials>> | undefined;
    if (input.email) {
      const user = await findUserByEmail(input.email);
      allowCredentials = user ? await listCredentials(user.id) : [];
    }

    const { options, challenge } = await startAssertion({ config, allowCredentials });

    const { token: challengeToken, expiresInSec } = await mint({
      plaintext: challenge,
      allowedActorId: CHALLENGE_ACTOR,
      ttlSec: 5 * 60,
    });

    return Response.json(
      { ok: true, options, challengeToken, expiresInSec },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "auth.webauthn.assertion-options.error");
  }
}
