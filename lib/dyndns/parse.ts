/**
 * lib/dyndns/parse.ts
 *
 * Pure parsing + response-formatting helpers for the DynDNS 2 contract
 * (https://help.dyn.com/remote-access-api/perform-update/). Operators
 * with an existing DynDNS setup use this endpoint with `ddclient` and
 * various router firmware; the contract is fixed text strings and the
 * tests pin exact byte-for-byte output.
 *
 * Kept DB- / framework-free so the round-trip is testable in isolation.
 * The HTTP route in `app/nic/update/route.ts` is the only orchestrator.
 */

/** All DynDNS 2 result codes. Body is always `<code> <ip?>` on the wire. */
export type DynDnsCode =
  | "good"
  | "nochg"
  | "nohost"
  | "badauth"
  | "notfqdn"
  | "numhost"
  | "abuse"
  | "dnserr"
  | "911";

export interface ParsedDynDnsRequest {
  /** Lowercased FQDN with no trailing dot. PDNS expects the dot; the route adds it. */
  hostname: string;
  /** Parsed source IP, or null when the client asks the server to detect. */
  myip: string | null;
}

export type DynDnsParse =
  | { kind: "ok"; req: ParsedDynDnsRequest }
  | { kind: "error"; code: DynDnsCode };

/**
 * Parse a /nic/update request. The standard supports a comma-separated
 * `hostname` list - we reject that with `numhost` because supporting it
 * complicates the audit story without operator demand.
 *
 * `myip` may be:
 *   - explicit ipv4/ipv6 (`?myip=…`)
 *   - omitted → caller derives from request socket (the route does)
 *   - "auto" (some clients send this) → treated as omitted
 */
export function parseDynDnsRequest(url: URL): DynDnsParse {
  const hostnameRaw = url.searchParams.get("hostname");
  if (!hostnameRaw) {
    return { kind: "error", code: "notfqdn" };
  }
  if (hostnameRaw.includes(",")) {
    return { kind: "error", code: "numhost" };
  }
  const hostname = hostnameRaw.trim().toLowerCase().replace(/\.$/, "");
  if (!isPlausibleFqdn(hostname)) {
    return { kind: "error", code: "notfqdn" };
  }

  const myipRaw = url.searchParams.get("myip");
  const myip =
    myipRaw && myipRaw.toLowerCase() !== "auto" && myipRaw.trim().length > 0
      ? myipRaw.trim()
      : null;
  if (myip && !isPlausibleIp(myip)) {
    // Bad explicit IP - fall through to dnserr rather than a more specific
    // code; DynDNS 2 has no `badip`. The route logs the rejection.
    return { kind: "error", code: "dnserr" };
  }

  return { kind: "ok", req: { hostname, myip } };
}

/**
 * Format the wire body. `good` and `nochg` MUST carry the IP per the
 * protocol; all other codes are bare strings. Output ends with no
 * newline - clients that parse `<code> <ip>` care about the literal
 * length.
 */
export function formatResponse(code: DynDnsCode, ip?: string): string {
  if ((code === "good" || code === "nochg") && ip) {
    return `${code} ${ip}`;
  }
  return code;
}

/**
 * Extract email + token from a Basic auth header. Returns null when the
 * header is missing, malformed, or doesn't decode cleanly. We don't
 * surface why - the caller turns null into `badauth`.
 */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^basic\s+(.+)$/i.exec(header.trim());
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  if (!user || !pass) return null;
  return { user, pass };
}

/**
 * Find the most-specific zone name (from a known set) that suffix-matches
 * the hostname. Both arguments are normalized (lowercase, NO trailing
 * dot - strip before passing). Returns the matching zone name (still
 * no trailing dot) or null.
 *
 * Suffix anchored on the literal label boundary so `evil-example.com`
 * isn't picked up as a match for `example.com`. The longest matching
 * zone wins, so an FQDN deep in a delegation hierarchy lands on its
 * actual zone, not a parent.
 */
export function findLongestZoneMatch(
  hostname: string,
  candidateZones: readonly string[],
): string | null {
  let best: string | null = null;
  for (const z of candidateZones) {
    if (hostname === z) {
      return z;
    }
    const suffix = `.${z}`;
    if (hostname.endsWith(suffix)) {
      if (best === null || z.length > best.length) {
        best = z;
      }
    }
  }
  return best;
}

const FQDN_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,62}[a-z0-9_])?$/;

function isPlausibleFqdn(name: string): boolean {
  if (name.length === 0 || name.length > 253) return false;
  // Must have at least one dot - a single label can't be an FQDN.
  if (!name.includes(".")) return false;
  return name.split(".").every((label) => FQDN_LABEL.test(label));
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;
function isPlausibleIp(s: string): boolean {
  if (s.length === 0 || s.length > 45) return false;
  if (IPV4.test(s)) {
    // Tighten: every octet must be 0–255.
    return s.split(".").every((o) => {
      const n = Number.parseInt(o, 10);
      return Number.isFinite(n) && n >= 0 && n <= 255;
    });
  }
  if (IPV6.test(s) && s.includes(":")) return true;
  return false;
}
