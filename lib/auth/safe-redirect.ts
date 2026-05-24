/**
 * lib/auth/safe-redirect.ts
 *
 * Validate a post-auth redirect target (the `?next=` an unauthenticated visitor
 * carried to the login page). Returns it only when it's a same-origin RELATIVE
 * path; otherwise falls back to `/dashboard`. This is the open-redirect guard:
 * an attacker must not be able to craft `…/login?next=https://evil/` (or the
 * protocol-relative `//evil`, or a backslash-smuggled variant) and have the app
 * bounce a freshly-authenticated user off-site.
 *
 * Pure (no server-only / no I/O) so both the login page + OIDC callback (server)
 * and any client caller can use the same rule.
 */

const DEFAULT_DESTINATION = "/dashboard";

export function safeNextPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_DESTINATION;
  // Must be a root-relative path. Reject absolute URLs, protocol-relative
  // ("//evil.com"), and backslash smuggling ("/\evil.com" — some parsers treat
  // backslash as a slash).
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return DEFAULT_DESTINATION;
  }
  // Never bounce back to the auth routes themselves (avoids redirect loops).
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) {
    return DEFAULT_DESTINATION;
  }
  return next;
}
