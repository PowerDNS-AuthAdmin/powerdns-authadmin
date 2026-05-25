/**
 * lib/validators/password-policy.ts
 *
 * Client-safe password-policy constants. Deliberately has NO `server-only`
 * import and no server dependencies, so client components (e.g. the signup /
 * login forms) can mirror the policy for instant feedback. The authoritative
 * enforcement still happens server-side in `lib/validators/users.ts` (which
 * re-exports these) and `lib/auth/password.ts`.
 */

/** Minimum password length we accept anywhere local passwords are written. */
export const MIN_PASSWORD_LENGTH = 12;
