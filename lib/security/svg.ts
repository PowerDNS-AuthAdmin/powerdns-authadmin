/**
 * lib/security/svg.ts
 *
 * Server-side SVG sanitization for the brand logo (issue #30).
 *
 * The logo is only ever rendered via `<img src={brandLogoUrl}>`, where the
 * browser renders SVG in "secure static mode" — `<script>`, `on*` handlers,
 * `<a>` navigation, and external subresource loads are all disabled, identically
 * for inline `data:` and hosted `https://` SVGs. So an inline SVG is no more
 * dangerous than a hosted one. This sanitizer is **defense-in-depth** for any
 * future code path that might render the stored value inline (e.g.
 * `dangerouslySetInnerHTML`) rather than through `<img>` — it strips the
 * script-capable constructs so the value at rest can never be a live payload.
 */

import "server-only";

/** `data:image/svg+xml[;params],<body>` — capture params + body. */
const SVG_DATA_URI = /^data:image\/svg\+xml(?<params>;[^,]*)?,(?<body>[\s\S]*)$/i;

/**
 * Remove script-capable constructs from an SVG document: `<script>` and
 * `<foreignObject>` elements (and their content), `on*` event-handler
 * attributes, and `javascript:`/external/protocol-relative refs in
 * `href`/`xlink:href` (rewritten to a harmless `#`). Pure string transform.
 */
export function sanitizeSvg(svg: string): string {
  return (
    svg
      // <script>…</script> and self-closing <script/>
      .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
      .replace(/<script\b[^>]*\/>/gi, "")
      // <foreignObject>…</foreignObject> can host arbitrary HTML/JS
      .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
      .replace(/<foreignObject\b[^>]*\/>/gi, "")
      // on* event-handler attributes (double-quoted, single-quoted, unquoted)
      .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
      .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
      .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, "")
      // javascript:/external/protocol-relative refs in (xlink:)href → "#"
      .replace(/\b((?:xlink:)?href)\s*=\s*"\s*(?:javascript:|https?:|\/\/)[^"]*"/gi, '$1="#"')
      .replace(/\b((?:xlink:)?href)\s*=\s*'\s*(?:javascript:|https?:|\/\/)[^']*'/gi, "$1='#'")
  );
}

/**
 * If `value` is an inline `data:image/svg+xml` URI, decode → {@link sanitizeSvg}
 * → re-encode (preserving the original base64/text encoding). Any other value
 * (raster `data:` URI, `http(s)://` URL) is returned unchanged — there's no
 * inline SVG to clean.
 */
export function sanitizeBrandLogoValue(value: string): string {
  const m = SVG_DATA_URI.exec(value);
  if (!m?.groups) return value;
  const params = m.groups["params"] ?? "";
  const body = m.groups["body"] ?? "";
  const isBase64 = /;base64/i.test(params);
  const raw = isBase64 ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  const clean = sanitizeSvg(raw);
  const reencoded = isBase64
    ? Buffer.from(clean, "utf8").toString("base64")
    : encodeURIComponent(clean);
  return `data:image/svg+xml${params},${reencoded}`;
}
