/**
 * lib/dns/zone-name.ts
 *
 * The one place zone names are canonicalised. PowerDNS identifies a zone by
 * its lowercase FQDN with the trailing dot ("example.com."); grants, audit
 * resource ids, cache keys and realtime event filters all key on that exact
 * spelling, so every input - URL segment, form field, YAML, zonefile
 * directive - goes through {@link canonicalZoneName} before it is compared or
 * stored. Hand-rolled "lowercase + add a dot" copies drifted (one trimmed, one
 * didn't; one compared without the dot), which is how a grant for
 * `example.com.` failed to match a request for `EXAMPLE.COM`.
 *
 * Pure, no imports - usable from client components, validators and parsers.
 */

/**
 * Canonical PowerDNS zone id: trimmed, lowercased, exactly one trailing dot.
 * The empty string stays empty so callers can reject it with their own
 * message instead of receiving `"."` (the root zone).
 */
export function canonicalZoneName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === "") return trimmed;
  return trimmed.endsWith(".") ? trimmed : `${trimmed}.`;
}

/** Whether two spellings name the same zone (case and trailing dot ignored). */
export function sameZoneName(a: string, b: string): boolean {
  return canonicalZoneName(a) === canonicalZoneName(b);
}

/**
 * Zone names are stored fully-qualified, with the canonical trailing dot
 * ("example.com."). The dot is correct on the wire but visually noisy in the
 * UI, so we strip it *for display only*.
 *
 * NEVER use this for anything sent back to PDNS, used as an audit/cache key, or
 * passed to an API - those need the canonical name. Display surfaces only.
 */
export function displayZoneName(name: string): string {
  return name.replace(/\.$/, "");
}
