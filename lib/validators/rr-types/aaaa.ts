/**
 * lib/validators/rr-types/aaaa.ts
 *
 * IPv6 address content for `AAAA` records.
 *
 * RFC 3596 § 2.2: AAAA RDATA is a 128-bit IPv6 address, presented per RFC
 * 4291 / 5952 (compressed form). We accept any valid textual form; the
 * normalize step produces RFC 5952's recommended canonical form (lowercase,
 * `::` compresses the longest run of zeros, no leading zeros).
 *
 * Validation strategy: parse the address into 8 16-bit groups using the
 * standard set of forms (full, double-colon, IPv4-mapped tail). Reject what
 * the parser can't accept; warn on special-use ranges that are RFC-legal
 * but unusual in published AAAA records (loopback, link-local, ULA,
 * multicast).
 */

import type { RRTypeValidator, RRValidationIssue } from "./types";

export const aaaaValidator: RRTypeValidator = {
  type: "AAAA",
  label: "IPv6 address",
  description: "Compressed or full IPv6 address (RFC 3596, presentation RFC 5952).",
  placeholder: "2001:db8::1",
  rfc: "RFC 3596",
  validate(content: string) {
    const issues: RRValidationIssue[] = [];
    const trimmed = content.trim();

    const parsed = parseIpv6(trimmed);
    if (!parsed) {
      return {
        issues: [
          {
            level: "error",
            message:
              "Not a valid IPv6 address. Expected hex groups separated by colons (e.g. 2001:db8::1).",
          },
        ],
        normalized: trimmed,
      };
    }

    // Range warnings.
    const [g0, g1] = parsed;
    if (parsed.every((g) => g === 0)) {
      issues.push({
        level: "warning",
        message: ":: (unspecified) — legal but unusual as a published AAAA value.",
      });
    } else if (parsed.slice(0, 7).every((g) => g === 0) && parsed[7] === 1) {
      issues.push({
        level: "warning",
        message:
          "::1 is loopback (RFC 4291 § 2.5.3); publishing it in DNS exposes a localhost-only address.",
      });
    } else if ((g0! & 0xffc0) === 0xfe80) {
      issues.push({
        level: "warning",
        message: "fe80::/10 is link-local — not routable beyond a single L2 segment.",
      });
    } else if ((g0! & 0xfe00) === 0xfc00) {
      issues.push({
        level: "warning",
        message: "fc00::/7 is Unique Local (RFC 4193) — private, not globally routable.",
      });
    } else if ((g0! & 0xff00) === 0xff00) {
      issues.push({
        level: "warning",
        message: "ff00::/8 is multicast — uncommon as an AAAA-record value.",
      });
    } else if (
      g0 === 0 &&
      g1 === 0 &&
      parsed[2] === 0 &&
      parsed[3] === 0 &&
      parsed[4] === 0 &&
      parsed[5] === 0xffff
    ) {
      issues.push({
        level: "warning",
        message:
          "IPv4-mapped IPv6 address (::ffff:0:0/96). Most resolvers won't treat this as an IPv4 fallback — publish an A record instead (RFC 4038 § 4.2).",
      });
    }

    return { issues, normalized: canonicalizeIpv6(parsed) };
  },
};

/**
 * Parse an IPv6 string into 8 16-bit groups. Handles double-colon and
 * IPv4-mapped tail forms. Returns null on any malformed input.
 */
function parseIpv6(input: string): number[] | null {
  if (input === "") return null;

  // Trim brackets if someone pasted "[::1]".
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);

  // Zone IDs (`%eth0`) aren't valid in zone data — reject.
  if (s.includes("%")) return null;

  // IPv4-mapped tail: split on the last colon if the tail looks like dotted-quad.
  let v4Tail: number[] | null = null;
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.includes(".", lastColon)) {
    const tail = s.slice(lastColon + 1);
    const tailMatch = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail);
    if (!tailMatch) return null;
    const octets = tailMatch.slice(1).map(Number);
    if (octets.some((o) => o < 0 || o > 255)) return null;
    v4Tail = octets;
    s = s.slice(0, lastColon + 1) + "0:0";
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;

  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : null;

  let groups: string[];
  if (right === null) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    // RFC 4291 § 2.2.2: '::' must represent one or more all-zero groups.
    // missing === 0 means the address is fully specified yet still contains
    // '::' (e.g. 1:2:3:4:5:6:7:8::), which is malformed — reject it.
    if (missing < 1) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  }

  const out: number[] = [];
  for (const g of groups) {
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  if (v4Tail) {
    out[6] = (v4Tail[0]! << 8) | v4Tail[1]!;
    out[7] = (v4Tail[2]! << 8) | v4Tail[3]!;
  }
  return out;
}

/**
 * RFC 5952 canonical form: lowercase, no leading zeros in any group, single
 * `::` over the longest run of consecutive zero groups (≥ 2 groups).
 */
function canonicalizeIpv6(groups: number[]): string {
  // Find longest run of zero groups, length ≥ 2.
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestStart = curStart;
        bestLen = curLen;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(":");

  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
