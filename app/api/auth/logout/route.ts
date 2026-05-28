/**
 * app/api/auth/logout/route.ts
 *
 * POST /api/auth/logout — revoke the current session and clear cookies.
 *
 * Idempotent: callable even without a session. We still audit-log the
 * call so a "logout pressed twice" pattern shows up in the trail.
 *
 * Response shape: 200 with JSON `{ ok, location }` where `location` is
 * either the IdP's RP-initiated-logout URL (when the session was minted
 * via OIDC and the IdP advertised an end_session_endpoint at sign-in
 * time) or the local `/login?signed-out=1` fallback. The client does a
 * top-level navigation via `window.location.replace(location)` —
 * specifically NOT a fetch-followed redirect, because the
 * `connect-src 'self'` CSP would block a fetch chain that ends on the
 * IdP's domain. Top-level navigation is exempt from connect-src.
 *
 * This mirrors certifi's flow exactly: see
 * certifi/crates/certifi-server/src/handlers/auth.rs#logout and
 * certifi/web/src/auth.tsx#logout.
 */

import { cookies, headers } from "next/headers";
import { env, isProduction, cookieDomain } from "@/lib/env";
import { appendAudit } from "@/lib/audit/log";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { readSession, endSession } from "@/lib/auth/session";
import { requireCsrf } from "@/lib/auth/csrf";
import { ForbiddenError } from "@/lib/errors";
import { logger } from "@/lib/logger";

/**
 * Cookie name + TTL for the "just-logged-out" suppression cookie. Read by
 * /login to skip `forceDefault` OIDC auto-redirect for a short window
 * after sign-out — without this, the IdP's still-valid session would
 * silently re-auth the user and they'd never see a logout confirmation.
 * 60 seconds is enough for the user to land back on /login + hit the
 * sign-in button manually if they want to. Belt-and-braces with the
 * existing `?signed-out=1` query-param check.
 */
const JUST_LOGGED_OUT_COOKIE = "pda_just_logged_out";
const JUST_LOGGED_OUT_TTL_SEC = 60;

export async function POST(request: Request): Promise<Response> {
  try {
    await requireCsrf(request);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  const session = await readSession();

  // RP-initiated-logout target — captured at OIDC sign-in time and
  // stored on the session row. Read it BEFORE endSession() destroys
  // the row. Local-source sessions and OIDC sessions on IdPs that
  // didn't advertise `end_session_endpoint` both fall through to the
  // local `/login?signed-out=1` redirect.
  const oidcLogoutUrl =
    session?.oidcEndSessionUrl && session.oidcIdToken
      ? buildRpLogoutUrl({
          endSessionUrl: session.oidcEndSessionUrl,
          idToken: session.oidcIdToken,
          clientId: session.oidcClientId,
        })
      : null;
  logger.info(
    {
      sessionId: session?.id ?? null,
      hasEndSessionUrl: !!session?.oidcEndSessionUrl,
      idTokenLen: session?.oidcIdToken?.length ?? 0,
      clientId: session?.oidcClientId ?? null,
      target: oidcLogoutUrl ? "idp" : "local-fallback",
    },
    "auth.logout.dispatch",
  );

  await endSession();

  // Mark this browser as "just logged out". /login reads this cookie and
  // suppresses the forceDefault OIDC auto-redirect — without this, a still-
  // valid IdP session re-auths the operator silently and they never see a
  // logout confirmation. HttpOnly so JS can't tamper, scoped to /login by
  // path so it doesn't leak into other requests.
  const cookieStore = await cookies();
  cookieStore.set(JUST_LOGGED_OUT_COOKIE, "1", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/login",
    domain: cookieDomain,
    maxAge: JUST_LOGGED_OUT_TTL_SEC,
  });

  const hdrs = await headers();
  await appendAudit({
    actor: { type: "user", id: session?.userId ?? null },
    action: "auth.logout",
    resource: { type: "session", id: session?.id ?? null },
    after: oidcLogoutUrl ? { rpInitiated: true } : { rpInitiated: false },
    request: {
      ip: getClientIp(hdrs),
      userAgent: hdrs.get("user-agent"),
      requestId: getRequestId(hdrs),
    },
  });

  // JSON response, not a redirect. The client navigates via
  // `window.location.replace()` so the cross-origin trip to the IdP's
  // end_session_endpoint isn't blocked by `connect-src 'self'` in our
  // CSP (which DOES apply to fetch-followed redirects but does NOT
  // apply to top-level navigations).
  return Response.json({
    ok: true,
    location: oidcLogoutUrl ?? `${env.APP_URL}/login?signed-out=1`,
  });
}

/**
 * Build an OpenID Connect RP-initiated-logout URL per the OpenID
 * Connect Session Management spec — `end_session_endpoint` plus
 * `id_token_hint` (so the IdP can identify the session to end) and
 * `client_id` (some IdPs require it).
 *
 * We deliberately OMIT `post_logout_redirect_uri`. Two reasons:
 *
 *   1. Most IdPs require it pre-registered. When it isn't, authentik
 *      / Keycloak / Okta silently strip it and either redirect home
 *      or show a generic logout screen — UX is unpredictable.
 *
 *   2. With forceDefault enabled, redirecting back to /login means
 *      the user instantly auto-bounces through the IdP and is
 *      silently signed back in (the IdP just ended their session,
 *      but the OIDC flow re-prompts only if forced via prompt=login
 *      — silent re-auth is the spec's default). Visible to the user
 *      as "logout did nothing."
 *
 * Same call as certifi makes (see `build_rp_logout_url` in its
 * services/auth.rs). authentik renders a perfectly good
 * "You've logged out" screen with explicit "Log back in" / "Log out
 * of authentik" buttons, putting the operator in control of what
 * happens next.
 */
function buildRpLogoutUrl(input: {
  endSessionUrl: string;
  idToken: string;
  clientId: string | null;
}): string {
  let url: URL;
  try {
    url = new URL(input.endSessionUrl);
  } catch {
    // Stored URL is malformed — return as-is so the browser still
    // lands on the IdP's logout page even without the hint params.
    return input.endSessionUrl;
  }
  url.searchParams.set("id_token_hint", input.idToken);
  if (input.clientId) url.searchParams.set("client_id", input.clientId);
  return url.toString();
}
