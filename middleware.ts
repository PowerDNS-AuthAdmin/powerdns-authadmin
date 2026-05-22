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
 * Build the Content-Security-Policy header value. Strict by default; relaxed only
 * where the framework or our own UI patterns genuinely need it.
 *
 * Pre-flight test before relaxing any source: are there fewer than 3 distinct
 * inline scripts we'd need to allow? If yes, refactor them to external files.
 */
function buildCsp(nonce: string, isDev: boolean, turnstileEnabled: boolean): string {
  // Cloudflare Turnstile (S-4): loaded from challenges.cloudflare.com and
  // renders inside an iframe served from the same origin. We open
  // script-src, frame-src, and connect-src to that single host ONLY when
  // the operator has configured the captcha — keeps the CSP tight
  // otherwise. Reading TURNSTILE_SITE_KEY directly from process.env is
  // safe: the site key is public by design (it ships to every browser).
  const turnstileOrigin = "https://challenges.cloudflare.com";

  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      // 'strict-dynamic' tells browsers to trust scripts loaded *by* trusted
      // scripts. Lets us avoid listing every chunk URL explicitly.
      "'strict-dynamic'",
      // Dev hot-reload eval()s. We never enable this in production.
      ...(isDev ? ["'unsafe-eval'"] : []),
      ...(turnstileEnabled ? [turnstileOrigin] : []),
    ],
    "style-src": [
      "'self'",
      // `'unsafe-inline'` is retained here deliberately, and cannot be
      // dropped without an app-wide refactor. Two hard constraints:
      //   1. React/Radix render `style="…"` ATTRIBUTES throughout (every
      //      dialog/dropdown/chart). Style attributes cannot carry a nonce
      //      — only `<style>`/`<link>` elements can — so the only CSP source
      //      that permits them is `'unsafe-inline'`.
      //   2. Adding a nonce does NOT help: under CSP3, the presence of a
      //      nonce makes Chromium/WebKit *ignore* `'unsafe-inline'` for both
      //      elements and attributes, which would then break those style
      //      attributes. And the granular `style-src-attr`/`style-src-elem`
      //      split that could thread this needle is ignored by Firefox
      //      (it falls back to `style-src`), so it can't be relied on.
      // Net: dropping `'unsafe-inline'` requires eliminating every inline
      // style attribute first. Tracked as future work. The risk is low —
      // `style-src` is the lowest-value CSP relaxation (no script, no
      // external load, no exfil-via-form); `script-src` stays strict
      // (nonce + 'strict-dynamic', no 'unsafe-inline').
      "'unsafe-inline'",
    ],
    // Images: anything from our own origin, inline data URIs, blob URLs, plus
    // arbitrary https origins. The HTTPS opening exists for operator-set brand
    // logo URLs in /admin/settings (e.g. https://example.com/logo.svg) and for
    // future avatar URLs from OIDC IdPs. We do NOT open script-src or
    // style-src — only the image directive, which is the lowest-risk channel
    // (no JS, no CSS, no exfil-via-form). `http:` is added in dev so
    // localhost-served logos work; production remains https-only.
    "img-src": ["'self'", "data:", "blob:", "https:", ...(isDev ? ["http:"] : [])],
    "font-src": ["'self'"],
    // `connect-src` is the network egress allow-list. Defaults to self; the auth
    // layer extends this for OIDC discovery URLs at runtime .
    "connect-src": [
      "'self'",
      ...(isDev ? ["ws:", "wss:"] : []),
      ...(turnstileEnabled ? [turnstileOrigin] : []),
    ],
    "frame-src": ["'self'", ...(turnstileEnabled ? [turnstileOrigin] : [])],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "upgrade-insecure-requests": [],
    // S-20 from `reports/audit-2026-05-16.md`. Browsers POST a JSON
    // body describing each blocked load to this endpoint; the handler
    // logs at warn level. No storage or admin UI yet  — the
    // logs are visible in any log aggregator and surface violations
    // that would otherwise be silent (the inevitable "we added a
    // third-party script and forgot to extend script-src" moment).
    //
    // We emit BOTH the legacy `report-uri` and the modern `report-to`.
    // `report-uri` is deprecated but still the only mechanism older
    // browsers (and some current Firefox configs) honor. `report-to`
    // names a group declared in the `Reporting-Endpoints` response
    // header (set below) and is the path forward for Chromium. Keeping
    // both means no browser silently drops violation reports.
    "report-uri": ["/api/csp-report"],
    "report-to": ["csp-endpoint"],
  };

  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
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
