/**
 * lib/dns/zone-name.ts
 *
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
