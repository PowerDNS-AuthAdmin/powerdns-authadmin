/**
 * lib/net/url-safety.ts
 *
 * Dialect-neutral SSRF guard for ANY operator-supplied outbound URL. The app
 * fetches two classes of operator-configured URLs — PowerDNS backend base URLs
 * and OIDC issuer URLs — and both must pass through this before being persisted
 * or requested. Domain wrappers (`lib/pdns/url-safety.ts`,
 * `lib/auth/providers/oidc-url-safety.ts`) supply the per-feature policy
 * (env-gated private-network / insecure-http allowances + reason wording).
 *
 * Always-blocked ranges (cannot be overridden by any policy):
 *   - IPv4 link-local 169.254.0.0/16  ← includes 169.254.169.254 cloud metadata,
 *     the highest-impact SSRF exfil vector.
 *   - IPv6 link-local fe80::/10, unspecified (0.0.0.0 / ::), multicast, broadcast,
 *     reserved.
 *
 * Conditionally-blocked (gated by `policy.allowPrivateNetworks`):
 *   - IPv4 loopback 127/8, RFC1918 10/8 · 172.16/12 · 192.168/16, CGNAT 100.64/10
 *   - IPv6 loopback ::1, ULA fc00::/7
 *
 * Re-checked at request time by callers (DNS-rebinding defense — the address that
 * resolved a minute ago is not guaranteed to be the same now).
 */

import "server-only";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { isProduction } from "@/lib/env";

/**
 * `safe: true` means every resolved address passed. `safe: false` carries a
 * user-facing reason (references the input, not internal state — safe to show).
 */
export type UrlSafetyResult = { safe: true; addresses: string[] } | { safe: false; reason: string };

export interface OutboundUrlPolicy {
  /** Allow loopback / RFC1918 / ULA destinations. */
  allowPrivateNetworks: boolean;
  /** Allow `http://` in production (otherwise https is required there). */
  allowInsecureHttp: boolean;
  /**
   * Treat a host that doesn't resolve (DNS failure / no addresses) as safe
   * rather than rejecting it. An unresolvable host is NOT an SSRF vector —
   * there's no internal address to reach — so for a URL validated at config
   * time but only fetched later (an OIDC issuer), we store it and let the
   * fetch-time re-check be the real guard. PDNS leaves this off: a backend you
   * can't resolve is definitionally unusable, so it fails fast on add.
   */
  treatUnresolvableAsSafe?: boolean;
  /** Noun used in reason strings, e.g. "Base URL" / "Issuer URL". */
  label: string;
  /** Appended to the https-in-production rejection — names the relax flag. */
  insecureHttpHint: string;
  /** Appended to the private-address rejection — names the relax flag. */
  privateNetworkHint: string;
}

// =============================================================================
// IPv4 range checks (bitwise on 32-bit integer)
// =============================================================================

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const oct = Number(part);
    if (!Number.isInteger(oct) || oct < 0 || oct > 255) return null;
    n = (n << 8) + oct;
  }
  // JS bitwise ops produce signed 32-bit; coerce to unsigned for comparisons.
  return n >>> 0;
}

interface V4Range {
  net: number;
  prefix: number;
}

function v4InRange(addr: number, range: V4Range): boolean {
  if (range.prefix === 0) return true;
  const mask = (0xffffffff << (32 - range.prefix)) >>> 0;
  return (addr & mask) === (range.net & mask);
}

const ALWAYS_BLOCKED_V4: V4Range[] = [
  { net: ipv4ToInt("169.254.0.0")!, prefix: 16 }, // link-local (cloud metadata!)
  { net: ipv4ToInt("0.0.0.0")!, prefix: 8 }, // "this network" / unspecified
  { net: ipv4ToInt("224.0.0.0")!, prefix: 4 }, // multicast
  { net: ipv4ToInt("255.255.255.255")!, prefix: 32 }, // limited broadcast
  { net: ipv4ToInt("240.0.0.0")!, prefix: 4 }, // reserved
];

const PRIVATE_V4: V4Range[] = [
  { net: ipv4ToInt("127.0.0.0")!, prefix: 8 }, // loopback
  { net: ipv4ToInt("10.0.0.0")!, prefix: 8 }, // RFC1918
  { net: ipv4ToInt("172.16.0.0")!, prefix: 12 }, // RFC1918
  { net: ipv4ToInt("192.168.0.0")!, prefix: 16 }, // RFC1918
  { net: ipv4ToInt("100.64.0.0")!, prefix: 10 }, // CGNAT
];

function classifyV4(addr: string): "ok" | "always-blocked" | "private" {
  const n = ipv4ToInt(addr);
  if (n === null) return "always-blocked";
  for (const range of ALWAYS_BLOCKED_V4) if (v4InRange(n, range)) return "always-blocked";
  for (const range of PRIVATE_V4) if (v4InRange(n, range)) return "private";
  return "ok";
}

// =============================================================================
// IPv6 range checks (prefix on byte array)
// =============================================================================

function ipv6ToBytes(ip: string): Uint8Array | null {
  const bare = ip.split("%")[0] ?? ip; // strip zone id ("%eth0")

  // Handle IPv4-mapped suffixes: ::ffff:1.2.3.4
  let v4Tail: number[] | null = null;
  const lastColon = bare.lastIndexOf(":");
  if (lastColon !== -1 && bare.includes(".", lastColon)) {
    const v4Str = bare.slice(lastColon + 1);
    const v4Int = ipv4ToInt(v4Str);
    if (v4Int === null) return null;
    v4Tail = [(v4Int >>> 24) & 0xff, (v4Int >>> 16) & 0xff, (v4Int >>> 8) & 0xff, v4Int & 0xff];
  }

  const head = v4Tail !== null ? bare.slice(0, bare.lastIndexOf(":") + 1) + "0:0" : bare;
  const expandable = head.split("::");
  if (expandable.length > 2) return null;

  const leftStr = expandable[0] ?? "";
  const rightStr = expandable[1] ?? null;
  const left = leftStr === "" ? [] : leftStr.split(":");
  const right = rightStr === null ? null : rightStr === "" ? [] : rightStr.split(":");

  let groups: string[];
  if (right === null) {
    if (left.length !== 8) return null;
    groups = left;
  } else {
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  }

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? "0";
    if (g.length === 0 || g.length > 4 || !/^[0-9a-fA-F]+$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  if (v4Tail) {
    bytes[12] = v4Tail[0]!;
    bytes[13] = v4Tail[1]!;
    bytes[14] = v4Tail[2]!;
    bytes[15] = v4Tail[3]!;
  }
  return bytes;
}

function v6HasPrefix(addr: Uint8Array, prefix: Uint8Array, prefixBits: number): boolean {
  let bitsLeft = prefixBits;
  let i = 0;
  while (bitsLeft >= 8) {
    if (addr[i] !== prefix[i]) return false;
    bitsLeft -= 8;
    i++;
  }
  if (bitsLeft === 0) return true;
  const mask = 0xff << (8 - bitsLeft);
  return ((addr[i] ?? 0) & mask) === ((prefix[i] ?? 0) & mask);
}

const V6_LINK_LOCAL = ipv6ToBytes("fe80::")!;
const V6_LOOPBACK = ipv6ToBytes("::1")!;
const V6_ULA = ipv6ToBytes("fc00::")!;
const V6_MULTICAST = ipv6ToBytes("ff00::")!;
const V6_V4MAPPED = ipv6ToBytes("::ffff:0:0")!;

function classifyV6(addr: string): "ok" | "always-blocked" | "private" {
  const bytes = ipv6ToBytes(addr);
  if (!bytes) return "always-blocked";
  // IPv4-mapped (::ffff:0:0/96) — recurse on the v4 tail.
  if (v6HasPrefix(bytes, V6_V4MAPPED, 96)) {
    return classifyV4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  if (v6HasPrefix(bytes, V6_LINK_LOCAL, 10)) return "always-blocked";
  if (v6HasPrefix(bytes, V6_MULTICAST, 8)) return "always-blocked";
  if (bytes.every((b) => b === 0)) return "always-blocked"; // unspecified ::
  if (v6HasPrefix(bytes, V6_LOOPBACK, 128)) return "private";
  if (v6HasPrefix(bytes, V6_ULA, 7)) return "private";
  return "ok";
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate that `urlString` is safe to fetch under `policy`:
 *   1. parses + is http(s);
 *   2. https in production unless `policy.allowInsecureHttp`;
 *   3. resolves the host (skipping DNS for literal IPs);
 *   4. every resolved IP is classified — always-blocked fails unconditionally,
 *      private fails unless `policy.allowPrivateNetworks`.
 */
export async function checkOutboundUrlSafe(
  urlString: string,
  policy: OutboundUrlPolicy,
): Promise<UrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: `${policy.label} is not a valid URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: `${policy.label} must use http:// or https://.` };
  }
  if (isProduction && url.protocol !== "https:" && !policy.allowInsecureHttp) {
    return {
      safe: false,
      reason: `${policy.label} must use https:// in production. ${policy.insecureHttpHint}`,
    };
  }

  const host = url.hostname;
  if (!host) return { safe: false, reason: `${policy.label} has no host.` };

  // Literal IP → validate directly; skip DNS.
  const literalKind = isIP(host) || isIP(stripBrackets(host));
  let addresses: string[];
  if (literalKind === 4 || literalKind === 6) {
    addresses = [stripBrackets(host)];
  } else {
    try {
      const records = await dns.lookup(host, { all: true });
      addresses = records.map((r) => r.address);
      if (addresses.length === 0) {
        if (policy.treatUnresolvableAsSafe) return { safe: true, addresses: [] };
        return { safe: false, reason: `Host '${host}' did not resolve to any addresses.` };
      }
    } catch (err) {
      // No resolution → no internal target → not an SSRF vector. Policies that
      // only fetch later (OIDC) opt to allow it; the fetch-time re-check guards.
      if (policy.treatUnresolvableAsSafe) return { safe: true, addresses: [] };
      const code = (err as { code?: string }).code ?? "";
      return { safe: false, reason: `Could not resolve '${host}'${code ? ` (${code})` : ""}.` };
    }
  }

  for (const addr of addresses) {
    const v = isIP(addr);
    const classification =
      v === 4 ? classifyV4(addr) : v === 6 ? classifyV6(addr) : "always-blocked";
    if (classification === "always-blocked") {
      return {
        safe: false,
        reason: `Host '${host}' resolves to ${addr}, which is in a network that is never allowed (loopback metadata, link-local, multicast, or unspecified).`,
      };
    }
    if (classification === "private" && !policy.allowPrivateNetworks) {
      return {
        safe: false,
        reason: `Host '${host}' resolves to ${addr}, which is a private address. ${policy.privateNetworkHint}`,
      };
    }
  }

  return { safe: true, addresses };
}
