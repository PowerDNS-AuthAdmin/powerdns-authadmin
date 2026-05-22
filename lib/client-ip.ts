/**
 * lib/client-ip.ts
 *
 * Single source of truth for "what's the client's IP for this request?".
 *
 * The app is designed to run behind a reverse proxy that terminates the
 * client connection and sets `X-Forwarded-For` / `X-Real-IP` (the bundled
 * compose files, and every supported deployment, put nginx/Traefik/Caddy or
 * a cloud LB in front). We therefore always read the leftmost XFF entry (the
 * originating client) and fall back to `X-Real-IP`.
 *
 * SECURITY CONTRACT: the fronting proxy MUST overwrite/strip any
 * client-supplied `X-Forwarded-For` so a caller can't spoof their IP to evade
 * rate limiting or poison audit logs. Standard proxies do this by default
 * (nginx `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`,
 * Traefik/Caddy/most cloud LBs). Do not expose this app directly to the
 * internet without such a proxy.
 *
 * Why not parse the socket address: Next.js route handlers don't expose the
 * underlying socket, and even when accessible it's the proxy's address, not
 * the client's. The forwarded headers are the contract that survives
 * framework changes.
 */

import "server-only";

/**
 * Best-effort client IP from request headers. Returns null only when neither
 * forwarded header carries a plausible IP (e.g. an internal probe that
 * bypasses the proxy). Rate-limit call sites fall back to a shared bucket on
 * null so the limiter still applies.
 *
 * Validates the value is a plausible IP shape. A pathological proxy that
 * forwards "<script>..." in XFF won't smuggle that into logs.
 */
export function getClientIp(headers: Headers): string | null {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first && isPlausibleIp(first)) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real && isPlausibleIp(real)) return real;
  return null;
}

const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

function isPlausibleIp(s: string): boolean {
  // Quick shape check — defends logs against obviously-non-IP input. The
  // strict structural check lives in `lib/pdns/url-safety.ts#isIP`.
  if (s.length === 0 || s.length > 45) return false;
  if (IPV4_RE.test(s)) return true;
  if (IPV6_RE.test(s) && s.includes(":")) return true;
  return false;
}

/**
 * Request-ID set by `middleware.ts`. Returns null only when middleware
 * didn't run (e.g. /_next/static paths that the matcher skips — those
 * never hit audit-writing routes, so the null is fine in practice).
 */
export function getRequestId(headers: Headers): string | null {
  return headers.get("x-request-id");
}

/**
 * One-shot context for audit-log `request` field. Routes that already pull
 * `headers()` for IP + UA get requestId for free.
 */
export function getRequestContext(headers: Headers): {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
} {
  return {
    ip: getClientIp(headers),
    userAgent: headers.get("user-agent"),
    requestId: getRequestId(headers),
  };
}
