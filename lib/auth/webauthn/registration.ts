/**
 * lib/auth/webauthn/registration.ts
 *
 * Thin wrapper around `@simplewebauthn/server`'s registration ceremony.
 * Two exports:
 *
 *   - `startRegistration({ user, existingCredentials })`
 *       → returns `{ options, challenge }`. Caller stashes `challenge`
 *         in the temp-reveal-store and ships `options` to the client.
 *
 *   - `verifyRegistration({ response, expectedChallenge, nickname })`
 *       → calls `verifyRegistrationResponse`, packs the verified credential
 *         into our `WebauthnCredential` shape, returns it. The route
 *         handler is responsible for persisting via the repository.
 *
 * Both functions take the resolved config (rpId, rpName, expectedOrigins,
 * etc.) so they're testable in isolation against fixture options.
 */

import "server-only";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  type GenerateRegistrationOptionsOpts,
  type PublicKeyCredentialCreationOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import type { User, WebauthnCredential } from "@/lib/db/schema";
import type { ResolvedWebauthnConfig } from "./config";

export interface StartRegistrationInput {
  config: ResolvedWebauthnConfig;
  user: Pick<User, "id" | "email" | "name">;
  /** Already-enrolled credentials, so the platform can refuse duplicates. */
  existingCredentials: ReadonlyArray<Pick<WebauthnCredential, "id" | "transports">>;
}

export async function startRegistration(input: StartRegistrationInput): Promise<{
  options: PublicKeyCredentialCreationOptionsJSON;
  challenge: string;
}> {
  // WebAuthn's userID is opaque to the authenticator (browsers prevent duplicate
  // registrations against the same (rpID, userID) pair). Use the user's UUID —
  // it's already unique and not PII.
  const userID = new TextEncoder().encode(input.user.id);

  const opts: GenerateRegistrationOptionsOpts = {
    rpName: input.config.rpName,
    rpID: input.config.rpId,
    userName: input.user.email,
    userID,
    userDisplayName: input.user.name ?? input.user.email,
    attestationType: input.config.attestation,
    excludeCredentials: input.existingCredentials.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    authenticatorSelection: {
      // residentKey: "preferred" enables discoverable credentials (passkeys)
      // without forcing every authenticator to support them. Lets older
      // U2F-style keys still enroll as a second factor.
      residentKey: "preferred",
      userVerification: input.config.userVerification,
    },
  };

  const options = await generateRegistrationOptions(opts);
  return { options, challenge: options.challenge };
}

export interface VerifyRegistrationInput {
  config: ResolvedWebauthnConfig;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
  /** User-supplied label for the credential ("MacBook Touch ID", "YubiKey 5"). */
  nickname: string;
}

export async function verifyRegistration(input: VerifyRegistrationInput): Promise<
  | {
      ok: true;
      credential: WebauthnCredential;
    }
  | {
      ok: false;
      reason: string;
    }
> {
  let result: VerifiedRegistrationResponse;
  try {
    result = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: input.config.expectedOrigins,
      expectedRPID: input.config.rpId,
      requireUserVerification: input.config.userVerification === "required",
    });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "verification-threw" };
  }

  if (!result.verified || !result.registrationInfo) {
    return { ok: false, reason: "not-verified" };
  }

  const info = result.registrationInfo;

  return {
    ok: true,
    credential: {
      id: info.credential.id,
      publicKey: isoBase64URL.fromBuffer(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      nickname: input.nickname,
    },
  };
}
