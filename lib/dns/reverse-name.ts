/**
 * lib/dns/reverse-name.ts
 *
 * IP address → reverse-DNS owner name, and which hosted reverse zone that owner
 * belongs to. The core of automatic PTR maintenance (`lib/dns/auto-ptr.ts`).
 *
 * Two things here are deliberately stricter than the usual `dns.reversename`
 * helper:
 *
 *   - Classless (RFC 2317) reverse zones. A /24 is the smallest block the
 *     in-addr.arpa tree can delegate natively, so a customer holding
 *     192.0.2.0/25 gets a zone named `0/25.2.0.192.in-addr.arpa.` (or the
 *     `0-127.2.0.192.in-addr.arpa.` spelling) and the PTR for 192.0.2.5 lives at
 *     `5.0/25.2.0.192.in-addr.arpa.`, not under the /24. When such a zone is
 *     hosted it wins over a plain `2.0.192.in-addr.arpa.`, because the parent
 *     only holds CNAMEs into it.
 *
 *   - IPv6 is compared and reversed on the fully expanded form, so
 *     `2001:db8::1` and `2001:0db8:0:0:0:0:0:1` are the same address, and an
 *     IPv4-mapped `::ffff:192.0.2.1` reverses as IPv6 (its PTR lives under
 *     ip6.arpa, which is where a resolver would look).
 *
 * Pure and dependency-free: route handlers, the editor's review modal and the
 * tests share it.
 */

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  /** Canonical presentation: dotted quad, or the full 32-nibble hex string for IPv6. */
  canonical: string;
}

/** Parse a dotted-quad IPv4 address. Leading zeros are rejected (octal ambiguity). */
export function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const octets: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const part = m[i]!;
    if (part.length > 1 && part.startsWith("0")) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/**
 * Expand an IPv6 address to 32 lowercase hex digits (no colons), or null when
 * the text is not a valid address. Handles `::` compression and an embedded
 * dotted-quad tail (`::ffff:192.0.2.1`). Zone identifiers (`%eth0`) are not
 * addresses and are rejected.
 */
export function expandIpv6(text: string): string | null {
  const s = text.trim().toLowerCase();
  if (s === "" || s.includes("%") || /[^0-9a-f:.]/.test(s)) return null;
  if (s.includes(":::")) return null;

  let body = s;
  let tail: string[] = [];
  // Embedded IPv4 in the last group.
  const lastColon = body.lastIndexOf(":");
  if (lastColon !== -1 && body.slice(lastColon + 1).includes(".")) {
    const v4 = parseIpv4(body.slice(lastColon + 1));
    if (!v4) return null;
    tail = [((v4[0]! << 8) | v4[1]!).toString(16), ((v4[2]! << 8) | v4[3]!).toString(16)];
    body = body.slice(0, lastColon + 1);
    // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::", "a:b:1.2.3.4" leaves "a:b:".
    if (!body.endsWith("::")) body = body.slice(0, -1);
  } else if (body.includes(".")) {
    return null;
  }

  const halves = body.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] | null => {
    if (part === "") return [];
    const out = part.split(":");
    for (const g of out) if (g === "" || g.length > 4) return null;
    return out;
  };
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !rest) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 2) {
    if (given > 7) return null;
    const fill = new Array<string>(8 - given).fill("0");
    return [...head, ...fill, ...rest, ...tail].map((g) => g.padStart(4, "0")).join("");
  }
  if (given !== 8) return null;
  return [...head, ...tail].map((g) => g.padStart(4, "0")).join("");
}

export function parseIp(text: string): ParsedIp | null {
  const v4 = parseIpv4(text);
  if (v4) return { family: 4, canonical: v4.join(".") };
  const v6 = expandIpv6(text);
  if (v6) return { family: 6, canonical: v6 };
  return null;
}

/**
 * The owner name a PTR for `ip` has in the global reverse tree, with the
 * trailing dot: `1.2.0.192.in-addr.arpa.` or the 32-nibble `…ip6.arpa.` form.
 * Null when `ip` is not an address.
 */
export function reverseOwnerName(ip: string): string | null {
  const parsed = parseIp(ip);
  if (!parsed) return null;
  if (parsed.family === 4) {
    return `${parsed.canonical.split(".").reverse().join(".")}.in-addr.arpa.`;
  }
  return `${parsed.canonical.split("").reverse().join(".")}.ip6.arpa.`;
}

export interface ReverseZoneMatch {
  /** Hosted zone name, canonical (lowercase, trailing dot). */
  zone: string;
  /** PTR owner name inside that zone, canonical. */
  owner: string;
  /** True when the zone is an RFC 2317 classless delegation. */
  classless: boolean;
}

/**
 * RFC 2317 zone name: `<first>/<prefix>.<c>.<b>.<a>.in-addr.arpa.` or
 * `<first>-<last>.<c>.<b>.<a>.in-addr.arpa.`. Returns the block it covers.
 */
function parseClasslessZone(
  zone: string,
): { first: number; last: number; parentLabels: string } | null {
  const m = /^(\d{1,3})([/-])(\d{1,3})\.(\d{1,3}\.\d{1,3}\.\d{1,3})\.in-addr\.arpa\.$/.exec(zone);
  if (!m) return null;
  const first = Number(m[1]);
  const n = Number(m[3]);
  if (first > 255) return null;
  let last: number;
  if (m[2] === "/") {
    // Prefix length. /25 … /32 are the only sizes that fit inside one /24.
    if (n < 25 || n > 32) return null;
    const size = 2 ** (32 - n);
    if (first % size !== 0) return null;
    last = first + size - 1;
  } else {
    last = n;
    if (last > 255 || last < first) return null;
  }
  return { first, last, parentLabels: m[4]! };
}

/**
 * Pick the hosted reverse zone a PTR for `ip` belongs to, and the owner name
 * inside it. `hostedZones` are canonical zone names (lowercase, trailing dot);
 * non-reverse zones are ignored. Most specific wins: a classless block before
 * its /24 parent, a longer suffix before a shorter one, `in-addr.arpa.` /
 * `ip6.arpa.` themselves last. Null when nothing hosted covers the address.
 */
export function findReverseZone(
  ip: string,
  hostedZones: Iterable<string>,
): ReverseZoneMatch | null {
  const parsed = parseIp(ip);
  const owner = reverseOwnerName(ip);
  if (!parsed || !owner) return null;
  const hosted = new Set<string>();
  for (const z of hostedZones) hosted.add(canonicalZone(z));

  if (parsed.family === 4) {
    const octets = parsed.canonical.split(".").map(Number) as [number, number, number, number];
    const parentLabels = `${octets[2]}.${octets[1]}.${octets[0]}`;
    let best: ReverseZoneMatch | null = null;
    for (const zone of hosted) {
      const block = parseClasslessZone(zone);
      if (block?.parentLabels !== parentLabels) continue;
      if (octets[3] < block.first || octets[3] > block.last) continue;
      // Two overlapping classless zones is a misconfiguration; the smaller block is the intended home.
      if (!best || block.last - block.first < bestSpan(best)) {
        best = { zone, owner: `${octets[3]}.${zone}`, classless: true };
      }
    }
    if (best) return best;
  }

  // Walk the owner's suffixes from the most specific zone to the tree root.
  const labels = owner.split(".");
  // labels ends with "" because of the trailing dot; the owner itself is never a zone.
  for (let i = 1; i < labels.length - 1; i++) {
    const candidate = labels.slice(i).join(".");
    if (hosted.has(candidate)) return { zone: candidate, owner, classless: false };
  }
  return null;
}

function bestSpan(match: ReverseZoneMatch): number {
  const block = parseClasslessZone(match.zone);
  return block ? block.last - block.first : Number.POSITIVE_INFINITY;
}

/** Lowercase with exactly one trailing dot. */
export function canonicalZone(name: string): string {
  const trimmed = name.trim().toLowerCase().replace(/\.+$/, "");
  return `${trimmed}.`;
}

/**
 * Whether two record contents are the same address. A and AAAA content is
 * presentation form, so `2001:db8::1` and `2001:DB8:0::1` must compare equal.
 */
export function sameAddress(a: string, b: string): boolean {
  const pa = parseIp(a);
  const pb = parseIp(b);
  if (!pa || !pb) return a.trim() === b.trim();
  return pa.family === pb.family && pa.canonical === pb.canonical;
}

/**
 * The address a PTR owner name stands for: `1.2.0.192.in-addr.arpa.` → 192.0.2.1,
 * `5.0/25.2.0.192.in-addr.arpa.` (RFC 2317) → 192.0.2.5, 32 nibbles under
 * `ip6.arpa.` → the IPv6 address. Null for anything else (a reverse zone apex,
 * a delegation label, a typo).
 */
export function ipFromReverseOwner(owner: string): string | null {
  const name = owner.trim().toLowerCase().replace(/\.$/, "");
  const v4 =
    /^(\d{1,3})\.(?:\d{1,3}[/-]\d{1,3}\.)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.in-addr\.arpa$/.exec(
      name,
    );
  if (v4) {
    const ip = `${v4[4]}.${v4[3]}.${v4[2]}.${v4[1]}`;
    return parseIpv4(ip) ? ip : null;
  }
  const v6 = /^((?:[0-9a-f]\.){31}[0-9a-f])\.ip6\.arpa$/.exec(name);
  if (v6) {
    const hex = v6[1]!.split(".").reverse().join("");
    const groups = hex.match(/.{4}/g)!.map((g) => parseInt(g, 16).toString(16));
    // RFC 5952 text form: compress the longest run of zero groups (two or more).
    let bestStart = -1;
    let bestLen = 0;
    for (let i = 0; i < groups.length; ) {
      if (groups[i] !== "0") {
        i++;
        continue;
      }
      let j = i;
      while (j < groups.length && groups[j] === "0") j++;
      if (j - i > bestLen) {
        bestStart = i;
        bestLen = j - i;
      }
      i = j;
    }
    if (bestLen >= 2) {
      return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLen).join(":")}`;
    }
    return groups.join(":");
  }
  return null;
}
