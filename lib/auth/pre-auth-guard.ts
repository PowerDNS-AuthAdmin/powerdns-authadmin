/**
 * lib/auth/pre-auth-guard.ts
 *
 * Cross-site guard for the JSON endpoints that run BEFORE a session exists
 * (login, LDAP login, MFA step, passkey challenge/verify). `requireCsrf`
 * can't protect these - there is no session secret yet - so without a
 * check a third-party page could submit a `<form enctype="text/plain">`
 * whose body happens to parse as JSON and log the victim's browser into an
 * attacker-controlled account (login CSRF). Two cheap, standard defences:
 *
 *   1. The body must be declared `application/json`. HTML forms cannot send
 *      that content type without a CORS preflight, which these routes never
 *      answer.
 *   2. When the browser sends `Origin` / `Sec-Fetch-Site`, they must say
 *      same-origin (or a navigation with no origin, `none`).
 *
 * Returns a Response to send back when the request must be refused, or
 * `null` when it may proceed - the pre-auth routes build their own JSON
 * error bodies rather than throwing.
 */

import { env } from "@/lib/env";

function appOrigin(): string {
  return new URL(env.APP_URL).origin;
}

export function rejectCrossSiteJson(request: Request): Response | null {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return Response.json(
      { error: "Expected an application/json body." },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null" && origin !== appOrigin()) {
    return Response.json(
      { error: "Cross-site request refused." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") {
    return Response.json(
      { error: "Cross-site request refused." },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}
