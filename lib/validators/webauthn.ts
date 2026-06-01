/**
 * lib/validators/webauthn.ts
 *
 * Zod schemas for the WebAuthn request bodies. The credential-response
 * payloads (`RegistrationResponseJSON`, `AuthenticationResponseJSON`) have
 * deeply-nested shapes defined by the W3C spec; we don't reimplement them
 * here - we accept a structural object and hand it to `@simplewebauthn/server`
 * which does the full spec validation. This module just gates the
 * surrounding fields (nickname, mode, optional email, challenge token) so
 * malformed payloads short-circuit before hitting the ceremony helpers.
 */

import { z } from "zod";

const credentialResponse = z.object({}).passthrough();

export const registrationVerifySchema = z.object({
  /** The single-use challenge token issued by /registration-options. */
  challengeToken: z.string().min(20).max(200),
  /** User-supplied label for the new credential - required, trimmed, 1..64 chars. */
  nickname: z.string().trim().min(1, "Nickname required.").max(64),
  /** The browser's `RegistrationResponseJSON` payload - validated downstream. */
  response: credentialResponse,
});

export const assertionOptionsSchema = z.object({
  /**
   * Optional email - when provided, the server can scope `allowCredentials`
   * to that user's set so the platform doesn't list every passkey on the
   * device. Omit for a discoverable-credential (passkey-first, username-less)
   * login.
   */
  email: z.string().email().optional(),
});

export const assertionVerifySchema = z
  .object({
    /** WebAuthn challenge token issued by /assertion-options. Always present. */
    challengeToken: z.string().min(20).max(200),
    /**
     * Whether this assertion is being submitted as the primary credential
     * (no password entered) or as a second factor after a successful
     * password POST to /api/auth/login. In `second-factor` mode the client
     * also sends `mfaToken` (the post-password MFA-pending token).
     */
    mode: z.enum(["primary", "second-factor"]),
    /**
     * Required when `mode === "second-factor"` - the MFA-pending token
     * returned by /api/auth/login when the user had MFA enrolled. The
     * server redeems it to learn which userId this assertion is for.
     */
    mfaToken: z.string().min(20).max(200).optional(),
    /** The browser's `AuthenticationResponseJSON` payload - validated downstream. */
    response: credentialResponse,
  })
  .refine((v) => v.mode !== "second-factor" || !!v.mfaToken, {
    message: "mfaToken is required for second-factor mode.",
    path: ["mfaToken"],
  });

export const credentialRenameSchema = z.object({
  nickname: z.string().trim().min(1).max(64),
});

export type RegistrationVerifyInput = z.infer<typeof registrationVerifySchema>;
export type AssertionOptionsInput = z.infer<typeof assertionOptionsSchema>;
export type AssertionVerifyInput = z.infer<typeof assertionVerifySchema>;
