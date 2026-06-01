/**
 * lib/auth/providers/types.ts
 *
 * Shared types across auth providers. Every provider eventually produces an
 * identity claim that the session-start path turns into a `users` row +
 * session row. The shape below is what providers must return.
 */

import "server-only";

export interface VerifiedIdentity {
  /** The provider that vouches for this identity ("local","oidc:google",…). */
  source: string;
  /** Email - canonical user identifier in our model. */
  email: string;
  /** Display name, if the provider gave us one. */
  name?: string;
  /** True if the provider's claim is "this email is verified". */
  emailVerified?: boolean;
  /** Free-form mapping data the provider wants to round-trip into audit. */
  claims?: Record<string, unknown>;
  /**
   * Material the OIDC RP-initiated-logout flow needs at sign-out time.
   * Captured here so the callback can stash it on the session row.
   * Null on every field for local-source sessions.
   */
  oidcLogout?: {
    /** `end_session_endpoint` from the IdP's discovery doc, if present. */
    endSessionUrl: string | null;
    /** The compact JWS id_token string returned at the token endpoint. */
    idToken: string | null;
    /** Client id used at sign-in - included in the logout redirect. */
    clientId: string | null;
    /**
     * Refresh token, if the IdP issued one (scope `offline_access`).
     * Captured plaintext from the provider's token-exchange response;
     * the callback handler MUST encrypt before persisting on the
     * session (`lib/crypto/encryption.ts`). Used by the token-auth
     * path to live-refresh the groups claim at API token use time.
     * Null when the IdP didn't issue one.
     */
    refreshToken?: string | null;
  };
}
