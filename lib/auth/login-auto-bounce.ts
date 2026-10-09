/**
 * lib/auth/login-auto-bounce.ts
 *
 * Decides whether `/login` should skip its own form and send the browser
 * straight to the default redirect-style provider (OIDC / SAML). Pure, so
 * the login page's branching is unit-testable.
 *
 * The auto-bounce exists so an install whose default is an IdP never shows
 * the local form on a plain visit. It must stay off when the operator is
 * deliberately looking at the page (`?force-local=1`), just signed out
 * (`?signed-out=1`, or the 60 s `pda_just_logged_out` cookie, otherwise
 * sign-out appears to do nothing), or has an error to read.
 *
 * A session that expired or was revoked is NOT one of those cases: the
 * request was for an app page, the app bounced it to `/login` with
 * `?flash=session-required`, and the operator expects to land back at the
 * IdP (which usually signs them straight back in). Before this helper the
 * page treated every `flash` as "not a fresh arrival" and showed the local
 * form, bypassing the default provider.
 */

/** Flash kinds that announce a lost session and must not block the bounce. */
const SESSION_LOST_FLASHES: ReadonlySet<string> = new Set(["session-required"]);

/** Error codes that only mean "sign in again" and must not block the bounce. */
const SESSION_LOST_ERRORS: ReadonlySet<string> = new Set(["session-expired"]);

export interface AutoBounceInput {
  /** `?error=<code>` on the login URL. */
  error?: string;
  /** `?flash=<kind>` on the login URL. */
  flash?: string;
  /** `?signed-out=1` present. */
  signedOut: boolean;
  /** `?force-local=1` present. */
  forceLocal: boolean;
  /** The short-lived cookie set by an explicit logout. */
  justLoggedOut: boolean;
}

export function shouldAutoBounceToDefault(input: AutoBounceInput): boolean {
  if (input.forceLocal || input.signedOut || input.justLoggedOut) return false;
  if (input.error !== undefined && !SESSION_LOST_ERRORS.has(input.error)) return false;
  if (input.flash !== undefined && !SESSION_LOST_FLASHES.has(input.flash)) return false;
  return true;
}
