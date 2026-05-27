/**
 * lib/auth/app-url-check.ts
 *
 * Compare the configured `APP_URL` against the request's actual host/scheme.
 * A mismatch means the browser-set Session + CSRF cookies (scoped to the
 * `APP_URL` host) get silently rejected by every browser — sign-in just looks
 * "broken" with no useful console message unless DevTools is open. The login
 * page surfaces a banner when this returns `mismatch=true` so operators don't
 * have to dig.
 *
 * Not a security control — the cookies stay correctly scoped to the configured
 * host either way. This is a usability + diagnostic check.
 *
 * Pure helper (no DB, no env import) so it's unit-testable. The login page is
 * the only caller; it passes `env.APP_URL` and the request headers in.
 */

export interface AppUrlMismatch {
  mismatch: boolean;
  /** Origin (scheme://host[:port]) the browser used to reach us. */
  actualOrigin: string;
  /** Origin parsed from `env.APP_URL`. */
  expectedOrigin: string;
}

/**
 * Reconstruct the browser-visible origin from request headers, honouring the
 * common reverse-proxy headers (`X-Forwarded-Host`, `X-Forwarded-Proto`).
 * Returns `null` when we can't determine a host header — that's not a
 * mismatch, it's "no signal" (avoid false-positive banners).
 *
 * @param requestHeaders the incoming request's `Headers` (Next.js `headers()`)
 * @param appUrl         the configured `env.APP_URL`
 * @param defaultProto   scheme to assume when X-Forwarded-Proto is absent.
 *                       Production callers should pass "https"; dev passes "http".
 */
export function detectAppUrlMismatch(
  requestHeaders: Headers,
  appUrl: string,
  defaultProto: "http" | "https",
): AppUrlMismatch | null {
  const forwardedHost = requestHeaders.get("x-forwarded-host");
  const host = forwardedHost ?? requestHeaders.get("host");
  if (!host) return null;

  const forwardedProto = requestHeaders.get("x-forwarded-proto");
  const proto = (forwardedProto?.split(",")[0]?.trim() ?? defaultProto).toLowerCase();

  // Take only the first value from XFF lists (proxies sometimes chain).
  const firstHost = host.split(",")[0]?.trim() ?? host;
  const actualOrigin = `${proto}://${firstHost}`;

  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(appUrl).origin;
  } catch {
    // env.ts already rejects a malformed APP_URL at boot, so we shouldn't get
    // here — but if we do, no banner beats a crash.
    return null;
  }

  return {
    mismatch: actualOrigin !== expectedOrigin,
    actualOrigin,
    expectedOrigin,
  };
}
