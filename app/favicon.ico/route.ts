/**
 * Browsers auto-request `/favicon.ico` for any document root, even when a
 * <link rel="icon"> points elsewhere. The real icon is `app/icon.svg`, which
 * Next injects into <head>; this handler answers the legacy probe so we don't
 * leave a 404 in the access log.
 *
 * It serves the icon itself rather than an empty 204. A 204 is a *null-body*
 * status, and returning one from a route handler Next wants to prerender broke
 * two ways at once in production:
 *
 *   - "LRUCache: calculateSize returned 0, but size must be > 0" - the response
 *     carries no bytes, so the prerender cache computed a zero size and
 *     refused to store it;
 *   - "TypeError: Response constructor: Invalid response status code 204" -
 *     replaying that cache entry reconstructs `new Response(body, { status })`
 *     with a non-null body, which the Response constructor rejects for 204.
 *
 * Serving real bytes with a 200 sidesteps both. SVG is correct here despite the
 * `.ico` name: browsers dispatch on Content-Type rather than the extension, and
 * anything old enough not to grok SVG uses the <link> in <head> instead.
 *
 * The markup is inlined rather than read from `app/icon.svg` at runtime,
 * because the production image is Next's `standalone` output - it ships
 * `.next/` and `node_modules/` but no source `app/` directory, so the read
 * would fail in the container and every request would fall through to a 404.
 * `favicon.test.ts` asserts this copy stays byte-identical to `app/icon.svg`,
 * so the two can't drift.
 */

export const ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><g fill="none" stroke="#4f8ef7" stroke-width="3.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4.5c-3.2 0-3.2 2.2-3.2 5.5s-1.8 5-4.3 6c2.5 1 4.3 2.7 4.3 6s0 5.5 3.2 5.5"/><path d="M18.5 4.5c3.2 0 3.2 2.2 3.2 5.5s1.8 5 4.3 6c-2.5 1-4.3 2.7-4.3 6s0 5.5-3.2 5.5"/></g></svg>';

export function GET(): Response {
  return new Response(ICON_SVG, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
