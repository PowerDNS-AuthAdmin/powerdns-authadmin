/**
 * lib/security/icon-url.ts
 *
 * The single scheme allowlist for operator-supplied icon URLs (OIDC login-
 * button icons, brand logos).
 *
 * Deliberately NOT `server-only`: the admin form renders a live `<img>`
 * preview of what's being typed, before anything reaches the server. That
 * preview is the one place the value is shown without having passed the Zod
 * validator, so it needs the same predicate - and it has to be the *same*
 * function, not a copy, or the two drift and the preview quietly becomes more
 * permissive than what can actually be saved (#113).
 *
 * Two structural rules keep this honest, and both matter:
 *
 *   1. **It returns a value, not a boolean.** Callers render what was
 *      validated. The original bug was a guard on `iconUrl` protecting a sink
 *      that rendered `iconUrl.trim()` - a different string, so the check said
 *      nothing about what was displayed.
 *   2. **Every accepted branch returns `parsed.href`.** The URL parser is the
 *      sole constructor of the output; the regex below is only ever a
 *      predicate. Nothing is reassembled from user-controlled fragments, so
 *      there is no path by which an unexamined substring reaches an
 *      `<img src>`. (Building the result from regex capture groups is what an
 *      earlier revision did, and it's genuinely weaker - the captures are
 *      still attacker-influenced text.)
 */

/**
 * The `pathname` of an accepted `data:` URL - `<mime>;base64,<payload>` - with
 * the payload constrained to a real base64 alphabet. Applied to the *parsed*
 * pathname rather than the raw input so it can't be fooled by anything the URL
 * parser would normalize away.
 */
const DATA_IMAGE_PATH = /^image\/(png|jpeg|jpg|gif|svg\+xml|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Normalize `value` to a URL that is safe to hand to an `<img src>`, or null
 * if it isn't one.
 *
 * Accepts an absolute http(s) URL or an inline base64 `data:image/...` URI.
 * Everything else - `javascript:`, `file:`, non-image `data:` types, unencoded
 * `data:` payloads, protocol-relative and relative paths, malformed input -
 * returns null.
 *
 * Note this is not the last line of defense against script execution: a
 * `javascript:` URL doesn't execute in an `<img src>` regardless, and browsers
 * render SVG there in secure static mode. It's the allowlist that keeps a
 * hostile-looking value from being rendered or stored in the first place.
 */
export function safeIconUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }

  switch (parsed.protocol) {
    case "https:":
    case "http:":
      return parsed.href;
    case "data:":
      return DATA_IMAGE_PATH.test(parsed.pathname) ? parsed.href : null;
    default:
      return null;
  }
}

/** Whether `value` is an acceptable icon URL. See {@link safeIconUrl}. */
export function isSafeIconUrl(value: string): boolean {
  return safeIconUrl(value) !== null;
}
