/**
 * lib/dns/txt.ts
 *
 * Shared TXT (and SPF - same wire format) presentation helpers. RFC 1035
 * § 3.3.14: TXT RDATA is one or more <character-string>s, each a
 * length-prefixed run of 0–255 octets. In presentation form each
 * character-string is quoted (`"…"`) and adjacent strings are
 * concatenated on the wire by consumers (RFC 7208 § 3.3 for SPF/DKIM).
 *
 * The key consequence - and the reason this module exists - is that the
 * SAME logical value can be presented in many equivalent ways:
 *
 *     "v=DKIM1; p=AAAA…"            (one long character-string)
 *     "v=DKIM1; p=AAAA" "…"          (split at 255 octets)
 *     "v=DKIM1; " "p=AAAA" "…"       (split at a different boundary)
 *
 * PowerDNS may store/return any of these depending on how the record was
 * entered and how a secondary re-chunked it after AXFR. Comparing the raw
 * presentation strings therefore reports false "out of sync" diffs. Use
 * `canonicalTxtContent` whenever you need to compare TXT values for
 * *equality of meaning* rather than byte-for-byte presentation.
 */

/**
 * Split a sequence of adjacent quoted character-strings into their
 * unescaped payloads. Returns null if the input isn't a well-formed run
 * of quoted strings (e.g. bare/legacy unquoted content) so callers can
 * fall back to exact comparison.
 */
export function extractQuotedStrings(input: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    // Skip whitespace between strings.
    while (i < input.length && /\s/.test(input.charAt(i))) i++;
    if (i >= input.length) break;
    if (input.charAt(i) !== '"') return null;
    i++; // consume opening quote
    let s = "";
    while (i < input.length && input.charAt(i) !== '"') {
      if (input.charAt(i) === "\\" && i + 1 < input.length) {
        // Decimal triple escape `\NNN`
        if (/\d/.test(input.charAt(i + 1)) && /^\d{3}/.test(input.slice(i + 1))) {
          const code = parseInt(input.slice(i + 1, i + 4), 10);
          if (code >= 0 && code <= 255) {
            s += String.fromCharCode(code);
            i += 4;
            continue;
          }
        }
        s += input.charAt(i + 1);
        i += 2;
      } else {
        s += input.charAt(i);
        i++;
      }
    }
    if (i >= input.length) return null; // missing closing quote
    i++; // consume closing quote
    out.push(s);
  }
  return out.length > 0 ? out : null;
}

/** UTF-8 octet length - how PDNS counts character-string sizes. */
export function octetLength(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/**
 * Reduce a TXT/SPF presentation value to a canonical form for equality
 * comparison: parse the character-strings, concatenate their payloads
 * (the bytes a resolver actually sees), and re-emit as a single escaped
 * quoted string. Any two presentations of the same logical value collapse
 * to the same output, so `"a" "b"` and `"ab"` compare equal.
 *
 * Content we can't parse as quoted strings (bare/legacy values) is
 * returned trimmed-but-unchanged, so comparison stays exact rather than
 * silently mangling it.
 */
export function canonicalTxtContent(content: string): string {
  const trimmed = content.trim();
  const strings = extractQuotedStrings(trimmed);
  if (!strings) return trimmed;
  const payload = strings.join("");
  // Escape backslash first, then the quote, so a literal `\` in the
  // payload doesn't get double-counted by the quote escape.
  return `"${payload.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
