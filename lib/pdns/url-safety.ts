/**
 * lib/pdns/url-safety.ts
 *
 * SSRF guard for PowerDNS backend URLs. Any user-supplied `baseUrl` (from the
 * admin "Add server" form) must pass through `assertSafePdnsUrl` before:
 *   - being persisted on the `pdns_servers` row, and
 *   - being requested from `lib/pdns/http.ts` (re-checked at request time as
 *     a DNS-rebinding defense — the address that resolved a minute ago is not
 *     guaranteed to be the same address right now).
 *
 * Always-blocked ranges (cannot be overridden):
 *   - IPv4 link-local 169.254.0.0/16   ← includes 169.254.169.254 cloud
 *     metadata; this is the highest-impact exfiltration vector for SSRF and
 *     there is no legitimate reason a PDNS backend would live there.
 *   - IPv6 link-local fe80::/10
 *   - unspecified addresses (0.0.0.0, ::)
 *   - multicast / broadcast
 *
 * Conditionally-blocked ranges (gated by `APP_PDNS_ALLOW_PRIVATE_NETWORKS`):
 *   - IPv4 loopback 127.0.0.0/8
 *   - IPv4 RFC1918 10/8, 172.16/12, 192.168/16
 *   - IPv4 CGNAT 100.64.0.0/10
 *   - IPv6 loopback ::1
 *   - IPv6 ULA fc00::/7
 *
 * In production these are blocked by default; the operator can opt in via
 * `APP_PDNS_ALLOW_PRIVATE_NETWORKS=true` when running an in-cluster PDNS reached
 * via a private hostname. In dev they're allowed by default so docker-compose
 * (`http://pdns:8081/api/v1` → 172.x.x.x) works without ceremony.
 */

import "server-only";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { env, isProduction } from "@/lib/env";
import { ValidationError } from "@/lib/errors";

/**
 * Result of a URL safety check. `safe: true` means every resolved address
 * passed. `safe: false` carries a user-facing reason that the admin form
 * surfaces verbatim — no need to redact, the reason references the input not
 * any internal state.
 */
export type UrlSafetyResult = { safe: true; addresses: string[] } | { safe: false; reason: string };

interface AssertOptions {
  /**
   * Force private networks to be allowed/denied regardless of env. Used by
   * tests so they don't depend on `process.env`.
   */
  allowPrivateNetworks?: boolean;
}

function privateNetworksAllowed(opts: AssertOptions): boolean {
  if (opts.allowPrivateNetworks !== undefined) return opts.allowPrivateNetworks;
  if (env.APP_PDNS_ALLOW_PRIVATE_NETWORKS !== undefined) {
    return env.APP_PDNS_ALLOW_PRIVATE_NETWORKS;
  }
  // Default: permissive in non-prod (docker-compose dev stack), strict in prod.
  return !isProduction;
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
  /** Network address as unsigned 32-bit. */
  net: number;
  /** Prefix length. */
  prefix: number;
}

function v4InRange(addr: number, range: V4Range): boolean {
  if (range.prefix === 0) return true;
  const mask = (0xffffffff << (32 - range.prefix)) >>> 0;
  return (addr & mask) === (range.net & mask);
}

const ALWAYS_BLOCKED_V4: V4Range[] = [
  // 169.254.0.0/16 — link-local (cloud metadata!)
  { net: ipv4ToInt("169.254.0.0")!, prefix: 16 },
  // 0.0.0.0/8 — "this network", unspecified
  { net: ipv4ToInt("0.0.0.0")!, prefix: 8 },
  // 224.0.0.0/4 — multicast
  { net: ipv4ToInt("224.0.0.0")!, prefix: 4 },
  // 255.255.255.255 — limited broadcast
  { net: ipv4ToInt("255.255.255.255")!, prefix: 32 },
  // 240.0.0.0/4 — reserved
  { net: ipv4ToInt("240.0.0.0")!, prefix: 4 },
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
  for (const range of ALWAYS_BLOCKED_V4) {
    if (v4InRange(n, range)) return "always-blocked";
  }
  for (const range of PRIVATE_V4) {
    if (v4InRange(n, range)) return "private";
  }
  return "ok";
}

// =============================================================================
// IPv6 range checks (prefix on byte array)
// =============================================================================

function ipv6ToBytes(ip: string): Uint8Array | null {
  // Strip zone id ("%eth0") if present.
  const bare = ip.split("%")[0] ?? ip;

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

/** Test if `addr` has the given bit prefix. */
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
    const v4 = `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
    return classifyV4(v4);
  }

  if (v6HasPrefix(bytes, V6_LINK_LOCAL, 10)) return "always-blocked";
  if (v6HasPrefix(bytes, V6_MULTICAST, 8)) return "always-blocked";
  // Unspecified is exactly ::
  if (bytes.every((b) => b === 0)) return "always-blocked";

  if (v6HasPrefix(bytes, V6_LOOPBACK, 128)) return "private";
  if (v6HasPrefix(bytes, V6_ULA, 7)) return "private";

  return "ok";
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Validate that `urlString` is safe to use as a PDNS backend URL.
 *
 * Performs:
 *   1. URL shape check (must parse; must be http(s)).
 *   2. In production, scheme must be https.
 *   3. DNS lookup of the hostname (resolves to one or more IPs).
 *   4. Each resolved IP is classified — always-blocked addresses fail
 *      unconditionally; private addresses fail unless allowed.
 *
 * Returns a discriminated result. The caller decides whether to throw or
 * surface the reason inline (`createPdnsServerSchema` throws via
 * `ValidationError`; the HTTP client throws via `PdnsUpstreamError`).
 */
export async function checkPdnsUrlSafe(
  urlString: string,
  opts: AssertOptions = {},
): Promise<UrlSafetyResult> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return { safe: false, reason: "Base URL is not a valid URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { safe: false, reason: "Base URL must use http:// or https://." };
  }
  // The https-in-production check is bypassable via the explicit opt-in
  // `APP_PDNS_ALLOW_INSECURE_HTTP=true` env. Operators on private networks
  // where TLS isn't terminated at PDNS (docker-compose, homelab, internal
  // service-mesh sidecars) flip this to true; the IP-range guard
  // (APP_PDNS_ALLOW_PRIVATE_NETWORKS) governs which destinations are
  // actually reachable.
  const insecureHttpAllowed = env.APP_PDNS_ALLOW_INSECURE_HTTP === true;
  if (isProduction && url.protocol !== "https:" && !insecureHttpAllowed) {
    return {
      safe: false,
      reason:
        "Base URL must use https:// in production. Set APP_PDNS_ALLOW_INSECURE_HTTP=true to allow http:// when PDNS lives on a private network without TLS.",
    };
  }

  const host = url.hostname;
  if (!host) {
    return { safe: false, reason: "Base URL has no host." };
  }

  // If the host is already a literal IP, validate it directly; skip DNS.
  const literalKind = isIP(host) || isIP(stripBrackets(host));
  let addresses: string[];
  if (literalKind === 4 || literalKind === 6) {
    addresses = [stripBrackets(host)];
  } else {
    try {
      const records = await dns.lookup(host, { all: true });
      addresses = records.map((r) => r.address);
      if (addresses.length === 0) {
        return {
          safe: false,
          reason: `Host '${host}' did not resolve to any addresses.`,
        };
      }
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      return {
        safe: false,
        reason: `Could not resolve '${host}'${code ? ` (${code})` : ""}.`,
      };
    }
  }

  const allowPrivate = privateNetworksAllowed(opts);

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
    if (classification === "private" && !allowPrivate) {
      return {
        safe: false,
        reason: `Host '${host}' resolves to ${addr}, which is a private address. Set APP_PDNS_ALLOW_PRIVATE_NETWORKS=true to allow this in your environment.`,
      };
    }
  }

  return { safe: true, addresses };
}

/**
 * Throwing variant: pass-through on success, raises `ValidationError` on
 * failure. Use from route handlers / repositories.
 */
export async function assertSafePdnsUrl(
  urlString: string,
  opts: AssertOptions = {},
): Promise<void> {
  const result = await checkPdnsUrlSafe(urlString, opts);
  if (!result.safe) {
    throw new ValidationError(result.reason);
  }
}

function stripBrackets(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}
