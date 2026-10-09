/**
 * lib/pdns/zone-id.ts
 *
 * PowerDNS' URL form of a zone name. The API identifies a zone by its
 * `zone_id`, which is the FQDN with every byte outside `[A-Za-z0-9.-]`
 * written as `=XX` (uppercase hex), a trailing dot added, and the root zone
 * spelled `=2E` (`apiZoneNameToId` in pdns/ws-api.cc). The decoder on the way
 * in only rewrites `=XX` sequences, so plain letters, digits, dots and hyphens
 * round-trip untouched - for the vast majority of zones the id IS the name.
 *
 * Why this matters: an RFC 2317 classless reverse zone such as
 * `0/25.2.0.192.in-addr.arpa.` contains a `/`. Percent-encoding it as `%2F`
 * is decoded by the HTTP server back to a path separator before PowerDNS
 * ever sees the id, and the request fails; the daemon's own form is
 * `0=2F25.2.0.192.in-addr.arpa.`. Encode the id this way first, then
 * percent-encode it for the path as usual.
 *
 * Pure; no PowerDNS call. Mirrors the daemon's algorithm exactly, including
 * the characters it escapes that would have survived a URL anyway (`_`), so
 * the output equals the `id` field PowerDNS reports for the zone.
 */

const SAFE = /^[A-Za-z0-9.-]$/;

/**
 * The PowerDNS `zone_id` for a zone name (any case / dot form is accepted;
 * the caller normally passes the canonical lowercase-dotted name).
 */
export function pdnsZoneIdForName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (SAFE.test(ch)) {
      out += ch;
    } else {
      for (const byte of Buffer.from(ch, "utf8")) {
        out += `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
      }
    }
  }
  if (!out.endsWith(".")) out += ".";
  // The root zone: a lone "." doesn't survive every HTTP stack, so PowerDNS
  // spells it as the escaped dot.
  if (out === ".") out = "=2E";
  return out;
}
