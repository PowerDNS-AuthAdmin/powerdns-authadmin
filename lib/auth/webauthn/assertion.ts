/**
 * lib/auth/webauthn/assertion.ts
 *
 * Thin wrapper around `@simplewebauthn/server`'s authentication ceremony.
 * Two exports:
 *
 *   - `startAssertion({ config, allowCredentials? })`
 *       → returns `{ options, challenge }`. When `allowCredentials` is
 *         omitted, the request is "discoverable" — the platform picks
 *         a credential from those bound to the RP and the user picker
 *         is shown by the OS. Used by the username-less passkey login
 *         button on `/login`.
 *
 *   - `verifyAssertion({ config, response, expectedChallenge, credential })`
 *       → calls `verifyAuthenticationResponse` with the stored credential,
 *         returns the new counter on success. The caller persists the
 *         counter bump via the repository (`touchCredential`).
 */

import "server-only";
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type VerifiedAuthenticationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { WebauthnCredential } from "@/lib/db/schema";
import type { ResolvedWebauthnConfig } from "./config";

export interface StartAssertionInput {
  config: ResolvedWebauthnConfig;
  /**
   * The user's already-registered credentials. When omitted (passkey-first
   * sign-in by email lookup elsewhere, or discoverable-credential flow), the
   * platform shows the user picker over every credential bound to the RP.
   */
  allowCredentials?: ReadonlyArray<Pick<WebauthnCredential, "id" | "transports">>;
}

export async function startAssertion(input: StartAssertionInput): Promise<{
  options: PublicKeyCredentialRequestOptionsJSON;
  challenge: string;
}> {
  const options = await generateAuthenticationOptions({
    rpID: input.config.rpId,
    allowCredentials: input.allowCredentials?.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    userVerification: input.config.userVerification,
  });
  return { options, challenge: options.challenge };
}

export interface VerifyAssertionInput {
  config: ResolvedWebauthnConfig;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  /** The stored credential (already looked up by id, base64url-decoded by us). */
  credential: Pick<WebauthnCredential, "id" | "publicKey" | "counter" | "transports">;
}

export async function verifyAssertion(
  input: VerifyAssertionInput,
): Promise<{ ok: true; newCounter: number } | { ok: false; reason: string }> {
  let result: VerifiedAuthenticationResponse;
  try {
    result = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.config.expectedOrigins,
      expectedRPID: input.config.rpId,
      credential: {
        id: input.credential.id,
        publicKey: isoBase64URL.toBuffer(input.credential.publicKey),
        counter: input.credential.counter,
        transports: input.credential.transports,
      },
      requireUserVerification: input.config.userVerification === "required",
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "verification-threw" };
  }

  if (!result.verified) {
    return { ok: false, reason: "not-verified" };
  }

  return { ok: true, newCounter: result.authenticationInfo.newCounter };
}
