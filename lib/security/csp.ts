/**
 * lib/security/csp.ts
 *
 * Builds the Content-Security-Policy header value. Pure (no request/runtime
 * deps) so it can be unit-tested in isolation; `proxy.ts` calls it with a
 * fresh per-request nonce. See ADR-0006 for the nonce + `'strict-dynamic'`
 * rationale.
 *
 * Strict by default; relaxed only where the framework or our own UI patterns
 * genuinely need it. Pre-flight test before relaxing any source: are there fewer
 * than 3 distinct inline scripts we'd need to allow? If yes, refactor them to
 * external files instead.
 */

/** Cloudflare Turnstile origin — its script, iframe, and API calls. */
const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export function buildCsp(nonce: string, isDev: boolean, turnstileEnabled: boolean): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      // NO 'self' / host-source / 'unsafe-inline' here: under CSP Level 3 the
      // presence of 'strict-dynamic' (below) makes browsers IGNORE all of them
      // in script-src — listing them does nothing and emits a console warning
      // ("Ignoring 'self' within script-src: 'strict-dynamic' specified").
      // Script trust comes solely from the per-request nonce plus
      // strict-dynamic propagation to scripts those nonced scripts load.
      `'nonce-${nonce}'`,
      // Trust scripts loaded *by* already-trusted (nonced) scripts, so we don't
      // have to enumerate every Next.js chunk URL.
      "'strict-dynamic'",
      // Dev hot-reload uses eval(). 'unsafe-eval' is a SEPARATE capability that
      // 'strict-dynamic' does not ignore, so it's still honored here. Never
      // enabled in production.
      ...(isDev ? ["'unsafe-eval'"] : []),
      // Turnstile is intentionally NOT listed here. Its loader is a `next/script`
      // tag (components/ui/turnstile-widget.tsx) that carries the nonce, so
      // 'strict-dynamic' authorizes it; a host-source would just be ignored.
      // The origin is allowed on frame-src + connect-src below, where
      // 'strict-dynamic' does not apply and the host source is honored.
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
    // Images: own origin, inline data URIs, blob URLs, plus arbitrary https
    // origins. The HTTPS opening exists for operator-set brand logo URLs in
    // /admin/settings and future OIDC avatar URLs. We do NOT open script-src or
    // style-src — only the image directive, the lowest-risk channel. `http:` is
    // added in dev so localhost-served logos work; production stays https-only.
    "img-src": ["'self'", "data:", "blob:", "https:", ...(isDev ? ["http:"] : [])],
    "font-src": ["'self'"],
    // `connect-src` is the network egress allow-list. Defaults to self; the auth
    // layer extends it for OIDC discovery URLs at runtime.
    "connect-src": [
      "'self'",
      ...(isDev ? ["ws:", "wss:"] : []),
      ...(turnstileEnabled ? [TURNSTILE_ORIGIN] : []),
    ],
    "frame-src": ["'self'", ...(turnstileEnabled ? [TURNSTILE_ORIGIN] : [])],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "upgrade-insecure-requests": [],
    // Browsers POST a JSON body describing each blocked load to this endpoint;
    // the handler logs at warn level. We emit BOTH the legacy `report-uri`
    // (deprecated but still the only mechanism older browsers / some Firefox
    // configs honor) and the modern `report-to` (names a group declared in the
    // `Reporting-Endpoints` response header, the path forward for Chromium) so
    // no browser silently drops violation reports.
    "report-uri": ["/api/csp-report"],
    "report-to": ["csp-endpoint"],
  };

  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}
