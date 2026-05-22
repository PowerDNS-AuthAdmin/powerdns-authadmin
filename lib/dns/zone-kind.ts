/**
 * lib/dns/zone-kind.ts
 *
 * Classify a zone as forward or reverse based on its name. Reverse
 * zones are sub-trees of `in-addr.arpa.` (IPv4) and `ip6.arpa.` (IPv6)
 * per RFC 1035 § 3.5 and RFC 3596 § 2.5. PowerDNS-AuthAdmin uses this
 * to:
 *
 *   - Restrict the record-type dropdown to types that make sense for
 *     the zone's kind (PTR/NS/DNAME/CNAME/TXT in reverse, everything
 *     else in forward).
 *   - Split the zones list into Forward / Reverse tabs so operators
 *     working on one set don't have to scroll past the other.
 *
 * Inputs are accepted with or without a trailing dot, lowercased before
 * comparison so `192.IN-ADDR.ARPA.` matches alongside the conventional
 * form.
 */

export type ZoneKind = "forward" | "reverse-ipv4" | "reverse-ipv6";

const IPV4_SUFFIX = ".in-addr.arpa";
const IPV6_SUFFIX = ".ip6.arpa";

/**
 * `true` for any sub-zone of `in-addr.arpa.` or `ip6.arpa.`. The
 * reverse trees themselves (`in-addr.arpa.` / `ip6.arpa.` with no
 * prefix) also count — operators occasionally host the root reverse
 * tree as a placeholder.
 */
export function isReverseZone(name: string): boolean {
  return zoneKind(name) !== "forward";
}

export function zoneKind(name: string): ZoneKind {
  const normalized = name.toLowerCase().replace(/\.$/, "");
  if (normalized === "in-addr.arpa" || normalized.endsWith(IPV4_SUFFIX)) {
    return "reverse-ipv4";
  }
  if (normalized === "ip6.arpa" || normalized.endsWith(IPV6_SUFFIX)) {
    return "reverse-ipv6";
  }
  return "forward";
}
