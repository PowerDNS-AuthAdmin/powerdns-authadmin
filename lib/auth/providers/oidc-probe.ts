/**
 * lib/auth/providers/oidc-probe.ts
 *
 * Operator-triggered reachability check for an OIDC issuer. Fetches
 * `${issuerUrl}/.well-known/openid-configuration` with a short
 * timeout, parses the JSON, and verifies the issuer claim matches.
 * Doesn't do full discovery (that's what `openid-client` is for at
 * sign-in time); just answers "is this URL reachable + serving a
 * valid OIDC config document?".
 *
 * Pure module: takes the URL as input, makes one fetch, returns a
 * discriminated result. No DB, no env, no logger — callers own
 * persistence + auditing.
 */

import "server-only";
import { makeGuardedFetch } from "@/lib/net/pinned-fetch";
import { checkOidcIssuerUrlSafe } from "./oidc-url-safety";

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Guarded + pinned fetch for the discovery probe. Re-runs the SSRF guard and
 * pins the validated address into the connection, so the reachability check
 * can't be DNS-rebound to an internal host between the guard's lookup and the
 * connect. The default; callers (tests) inject a mock via `fetchImpl`.
 */
const guardedProbeFetch = makeGuardedFetch(checkOidcIssuerUrlSafe) as unknown as typeof fetch;

export type ProbeResult =
  | { ok: true; endSessionEndpoint: string | null }
  | { ok: false; reason: ProbeFailureReason };

export type ProbeFailureReason =
  | "transport"
  | "http-status"
  | "invalid-json"
  | "missing-issuer"
  | "issuer-mismatch";

/**
 * Probe an OIDC issuer URL. Strips trailing slash before composing
 * the discovery path so `https://idp/` and `https://idp` behave
 * identically.
 */
export async function probeOidcDiscovery(
  issuerUrl: string,
  fetchImpl: typeof fetch = guardedProbeFetch,
): Promise<ProbeResult> {
  const base = issuerUrl.replace(/\/+$/, "");
  const discoveryUrl = `${base}/.well-known/openid-configuration`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, reason: "transport" };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return { ok: false, reason: "http-status" };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "invalid-json" };
  }

  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "invalid-json" };
  }
  const issuer = (body as Record<string, unknown>)["issuer"];
  if (typeof issuer !== "string") {
    return { ok: false, reason: "missing-issuer" };
  }
  // Issuer claim should match the URL the operator configured
  // (trailing slash insensitive — some IdPs return slash-suffixed
  // issuer, some don't).
  if (issuer.replace(/\/+$/, "") !== base) {
    return { ok: false, reason: "issuer-mismatch" };
  }

  // RP-initiated-logout diagnostic. When the IdP doesn't advertise an
  // `end_session_endpoint`, /api/auth/logout falls back to the local
  // `/login?signed-out=1` redirect — which combined with forceDefault
  // OIDC re-bouncing makes sign-out appear to do nothing. Surface the
  // missing endpoint to the admin UI so operators can fix it (Keycloak:
  // enable Front Channel Logout; Authentik: SAML/OIDC logout flow).
  const endSessionRaw = (body as Record<string, unknown>)["end_session_endpoint"];
  const endSessionEndpoint = typeof endSessionRaw === "string" ? endSessionRaw : null;

  return { ok: true, endSessionEndpoint };
}

/**
 * Human-readable label for a probe failure. Operator-facing string
 * shown next to the badge — doesn't leak the underlying HTTP
 * status / error class (those go in server logs via the audit row).
 */
export function probeFailureLabel(reason: ProbeFailureReason): string {
  switch (reason) {
    case "transport":
      return "Could not reach the issuer URL.";
    case "http-status":
      return "Issuer returned a non-200 response.";
    case "invalid-json":
      return "Issuer response was not valid JSON.";
    case "missing-issuer":
      return "Discovery document is missing the issuer field.";
    case "issuer-mismatch":
      return "Discovery document's issuer does not match the configured URL.";
  }
}
