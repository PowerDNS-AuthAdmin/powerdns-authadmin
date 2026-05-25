/**
 * lib/auth/require-user.ts
 *
 * Server-component / route-handler guard. Throws `UnauthorizedError` when
 * there's no authenticated user — the HTTP layer maps that to 401, the App
 * Router maps it to a redirect to /login (via `app/(app)/layout.tsx`).
 *
 * Usage from a server component:
 *
 *   const { user, ability } = await requireUser();
 *
 * Usage with a permission check:
 *
 *   const { user, ability } = await requireUser({ can: "zone.read" });
 *
 * The `can` short-form takes a permission string and infers the subject;
 * for resource-instance checks call `requirePermission()` from `lib/rbac/policy.ts`.
 */

import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { UnauthorizedError, ForbiddenError } from "@/lib/errors";
import type { Subject } from "@/lib/rbac/ability";
import { listRoleMfaStatesForUser } from "@/lib/db/repositories/roles";
import { getCurrentUser, type AuthenticatedRequest } from "./get-current-user";
import { evaluateSessionCompliance } from "./session-compliance";

export interface RequireUserOptions {
  /**
   * If set, also enforce that the user can perform the given action on the
   * given subject. Action and subject derived from the permission string:
   *   "zone.read"   → action="read",   subject="Zone"
   */
  can?: string;
  /**
   * If `can` is set, the optional subject *instance* to check against. Skips
   * this when checking type-level access ("can the user read any Zone?").
   */
  on?: Exclude<Subject, string>;
  /**
   * Skip the post-authorization compliance gate (forced MFA enrollment +
   * mustChangePassword). Set this ONLY on the self-remediation endpoints a
   * non-compliant operator must reach to fix their state (TOTP enrollment,
   * password change) — otherwise they'd deadlock — and on page renders, which
   * `requireUserForPage` already gates via the `(app)` layout redirect.
   */
  skipComplianceGate?: boolean;
}

export async function requireUser(opts: RequireUserOptions = {}): Promise<AuthenticatedRequest> {
  const result = await getCurrentUser();
  if (!result) throw new UnauthorizedError("Sign-in required.");

  if (opts.can) {
    const dotIdx = opts.can.indexOf(".");
    if (dotIdx === -1) {
      throw new Error(`requireUser: malformed permission '${opts.can}'`);
    }
    const action = opts.can.slice(dotIdx + 1);

    if (opts.on) {
      // A concrete resource instance was supplied — do a properly scoped
      // CASL check. A team/zone/server-scoped rule grants the action only
      // when the instance matches the scope's conditions.
      if (!result.ability.can(action, opts.on)) {
        throw new ForbiddenError(`Missing permission: ${opts.can}`);
      }
    } else {
      // No instance — this is an "any resource of this type" decision (list
      // endpoints, creation, admin-wide actions). Only a GLOBAL grant
      // satisfies it. We deliberately do NOT use a type-level
      // `ability.can(action, "Type")` here: CASL returns true for a
      // conditionally-scoped rule too, which would let a team-scoped role
      // act globally. See `globalPermissionsOf`.
      if (!result.globalPermissions.has(opts.can)) {
        throw new ForbiddenError(`Missing permission: ${opts.can}`);
      }
    }
  }

  // Compliance gate (security): a session can be FULLY authenticated yet
  // non-compliant — a role requires MFA but the operator never enrolled TOTP,
  // or they signed in with a temp password flagged `mustChangePassword`. The
  // `(app)` layout already redirects browser page loads, but route handlers
  // bypass the layout entirely, so without this check a non-compliant user
  // could drive write APIs directly. Enforce it here so every guarded handler
  // is covered. Token (PAT) auth is exempt: a non-compliant user can't mint a
  // PAT (creation is itself gated), and PATs are a separate deliberate
  // credential, not the interactive session this gate is about.
  if (result.source === "session" && !opts.skipComplianceGate) {
    const roleMfaStates = await listRoleMfaStatesForUser(result.user.id);
    const compliance = evaluateSessionCompliance(
      {
        totpEnrolled: result.user.totpSecretEncrypted !== null,
        ssoOnly: result.user.passwordHash === null,
        mfaOverride: result.user.mfaRequired,
        mustChangePassword: result.user.mustChangePassword,
      },
      roleMfaStates,
    );
    if (!compliance.ok) {
      if (compliance.reason === "mfa") {
        throw new ForbiddenError("MFA enrollment required before performing this action.");
      }
      throw new ForbiddenError("Password change required before performing this action.");
    }
  }

  return result;
}

/**
 * Page-level variant of `requireUser`. Where the base helper *throws*
 * (route handlers want that — they catch and return a JSON 401/403), this
 * one *redirects*:
 *
 *   - No session → `/login`
 *   - Authenticated but missing a permission → `/dashboard?flash=forbidden&need=<perm>`
 *
 * The `(app)` layout mounts a `<FlashListener>` that reads the `flash`
 * query param and surfaces a toast — far better UX than the default Next
 * error overlay when a user clicks a nav link they don't actually have
 * access to (e.g. an OIDC-provisioned user with no roles assigned).
 *
 * Only use this from server components rendering full pages. Route
 * handlers should keep using `requireUser` so they return proper HTTP
 * status codes.
 */
export async function requireUserForPage(
  opts: RequireUserOptions = {},
): Promise<AuthenticatedRequest> {
  try {
    // Pages don't double-gate: the `(app)` layout already enforces compliance
    // and redirects to /profile (nicer UX than a thrown ForbiddenError). The
    // permission check still runs.
    return await requireUser({ ...opts, skipComplianceGate: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      // Carry the attempted path so login can return the user there (L-2).
      const attempted = (await headers()).get("x-pathname");
      const next = attempted && attempted !== "/" ? `&next=${encodeURIComponent(attempted)}` : "";
      redirect(`/login?flash=session-required${next}`);
    }
    if (err instanceof ForbiddenError) {
      // Block the navigation: send the user back to where they came from
      // (same-origin referer) with a flash so the listener can toast. If the
      // request landed cold (URL typed directly, external referer, no referer
      // at all), fall back to the dashboard. Either way the unauthorized URL
      // never resolves to a content render.
      const hdrs = await headers();
      const referer = hdrs.get("referer");
      redirect(buildForbiddenRedirect(referer, opts.can));
    }
    throw err;
  }
}

/**
 * Compute the redirect target for a forbidden page load.
 *
 *  - Same-origin referer that isn't a stripped flash URL → that path (with
 *    flash query merged in), so the user "stays" where they were.
 *  - Anything else → `/dashboard?flash=forbidden`. Direct URL access, an
 *    external referer (privacy-mode browsers omit referer), or a referer
 *    pointing at /login all land here.
 *
 * Exported for unit-testability.
 */
export function buildForbiddenRedirect(referer: string | null, can: string | undefined): string {
  const flashPairs = ["flash=forbidden"];
  if (can) flashPairs.push(`need=${encodeURIComponent(can)}`);
  const flashQuery = flashPairs.join("&");

  if (referer) {
    try {
      const refUrl = new URL(referer);
      const appUrl = new URL(env.APP_URL);
      if (
        refUrl.origin === appUrl.origin &&
        !refUrl.pathname.startsWith("/login") &&
        !refUrl.pathname.startsWith("/api/")
      ) {
        const existing = refUrl.search.replace(/^\?/, "");
        // Strip any prior `flash`/`need` from the referer so we don't
        // accumulate duplicates across consecutive forbidden clicks.
        const filtered = existing
          .split("&")
          .filter((kv) => kv && !kv.startsWith("flash=") && !kv.startsWith("need="))
          .join("&");
        const merged = [filtered, flashQuery].filter(Boolean).join("&");
        return `${refUrl.pathname}?${merged}`;
      }
    } catch {
      // Malformed referer header → fall through to dashboard.
    }
  }
  return `/dashboard?${flashQuery}`;
}
