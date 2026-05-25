/**
 * middleware.ts
 *
 * Next.js Edge middleware that runs on every request. It applies the security
 * headers — most importantly a per-request CSP nonce — generates and propagates
 * a request id for log + audit correlation, and forwards the nonce and request
 * pathname to server components via request headers.
 *
 * Why a per-request nonce instead of static CSP: Next.js streams inline scripts
 * for hydration data. A static `script-src 'self'` CSP would block them; the only
 * alternatives are `'unsafe-inline'` (which defeats most of CSP's value) or
 * per-request nonces. Nonces win. See ADR-0006.
 */

import { type NextRequest, NextResponse } from "next/server";
import { buildCsp } from "@/lib/security/csp";

// Cryptographically random nonce. 16 random bytes → 24 base64 chars. Generated on
// every request because that's the whole point — a stale nonce defeats CSP.
function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Base64 without padding fits CSP's nonce-source format.
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");
}

/**
 * Allow an upstream-set `x-request-id` only when it looks like a sane
 * identifier — UUID, ULID, KSUID, or any opaque token of safe characters.
 * Pathological inputs (newlines, control bytes, header-injection attempts)
 * get replaced by a fresh UUID instead.
 */
function isPlausibleRequestId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(value);
}

/**
 * The middleware itself.
 *
 * `export default` is required by Next.js — this is one of the small set of files
 * exempt from our "no default exports" rule (see eslint.config.mjs).
 */
export default function middleware(request: NextRequest): NextResponse {
  const isDev = process.env.NODE_ENV === "development";
  const turnstileEnabled = Boolean(process.env["TURNSTILE_SITE_KEY"]);
  const nonce = generateNonce();
  const csp = buildCsp(nonce, isDev, turnstileEnabled);

  // Request-ID for log/audit correlation. Honor an upstream proxy's value
  // when it looks sane (so distributed traces stay joined); otherwise mint
  // a fresh UUID. Forwarded to route handlers via the request headers AND
  // echoed back to the client via response so support can quote it.
  const upstreamId = request.headers.get("x-request-id");
  const requestId =
    upstreamId && isPlausibleRequestId(upstreamId) ? upstreamId : crypto.randomUUID();

  // Forward the nonce to the route handler / server components via a request
  // header. Next.js' framework code reads `x-nonce` automatically and attaches
  // it to its own inline scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("x-request-id", requestId);
  // Forward the request pathname so server components can branch on
  // the current route — Next.js doesn't expose `usePathname()` on the
  // server side without a hook. Used today by `(app)/layout.tsx` to
  // allowlist MFA-enrollment routes when redirecting non-compliant
  // operators. Set verbatim from `nextUrl.pathname` (no query string).
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  // === Response security headers ===

  response.headers.set("Content-Security-Policy", csp);
  // Declares the `csp-endpoint` group referenced by the CSP `report-to`
  // directive. The Reporting API is the modern replacement for the
  // deprecated `report-uri`; both target the same handler so reports land
  // regardless of which mechanism a given browser supports.
  response.headers.set("Reporting-Endpoints", 'csp-endpoint="/api/csp-report"');
  response.headers.set("x-request-id", requestId);

  // Hide our stack from passive fingerprinting.
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Defense in depth on top of CSP `frame-ancestors`.
  response.headers.set("X-Frame-Options", "DENY");

  // Limit how much referrer info leaks to external origins.
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Lock down browser features we don't use. Add only what we need over time.
  response.headers.set(
    "Permissions-Policy",
    [
      "accelerometer=()",
      "autoplay=()",
      "camera=()",
      "clipboard-read=()",
      "clipboard-write=(self)",
      "fullscreen=(self)",
      "geolocation=()",
      "gyroscope=()",
      "magnetometer=()",
      "microphone=()",
      "midi=()",
      "payment=()",
      "usb=()",
    ].join(", "),
  );

  // Cross-origin isolation. Strict by default; relaxed when integrating an embed.
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Cross-Origin-Resource-Policy", "same-origin");

  // HSTS — production only. We never want to send this from a dev server (would
  // make `localhost` redirect to HTTPS forever).
  if (!isDev) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload",
    );
  }

  return response;
}

// Skip the middleware for static assets and Next's internal routes.
export const config = {
  matcher: [
    /*
     * Run on every path except:
     *   _next/static     — bundled assets, hashed, served with long-cache headers
     *   _next/image      — next/image optimizer responses (CSP would break inline svg)
     *   favicon.ico      — static asset
     *   robots.txt       — static
     *   sitemap.xml      — static
     * Health endpoints DO run through the middleware — we want their responses to
     * carry the security headers too.
     */
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
