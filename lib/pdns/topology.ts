/**
 * lib/pdns/topology.ts
 *
 * Derive replication topology from PowerDNS truth (ADR-0014). A Slave/Secondary
 * zone's `masters[]` holds DNS-layer AXFR source addresses (IP[:port][;tsig]) —
 * NOT API URLs. We match those against each backend's *advertised DNS
 * addresses* to draw a real primary→secondary edge. The match key is the AXFR
 * address, not NS membership, so hidden primaries (deliberately absent from the
 * NS set) resolve correctly. Anything we can't match is an external/unmanaged
 * node — never a false "orphan".
 *
 * Pure: no I/O. Advertised addresses default to the host parsed from the API
 * base URL; operators override per backend when the API host ≠ the DNS address.
 */

// Bare host/IP of an API base URL — sourced from the shared util and re-exported
// so the topology matcher and its tests keep importing it from here.
import { hostFromUrl } from "@/lib/net/host";
export { hostFromUrl };

/**
 * Normalize a `masters[]` entry (or an advertised address) to a bare,
 * lowercase host/IP: strips a `;tsigkey` suffix, `[...]` IPv6 brackets, and a
 * trailing `:port` (but keeps a bare, unbracketed IPv6 intact).
 */
export function normalizeMaster(master: string): string {
  let m = master.trim();
  const semi = m.indexOf(";");
  if (semi >= 0) m = m.slice(0, semi).trim();

  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(m);
  if (bracketed) return bracketed[1]!.toLowerCase();

  // A single colon means host:port; multiple colons means a bare IPv6 (no port).
  if ((m.match(/:/g) ?? []).length <= 1) {
    const colon = m.indexOf(":");
    if (colon >= 0) m = m.slice(0, colon);
  }
  return m.toLowerCase();
}

/** Minimal backend shape the matcher needs. */
export interface TopologyBackend {
  id: string;
  name: string;
  slug: string;
  baseUrl: string;
  advertisedAddresses: string[] | null;
}

/**
 * Advertised DNS addresses for a backend: the operator-set list when present,
 * else the single host parsed from the API base URL. Normalized for matching.
 */
export function advertisedAddressesFor(
  row: Pick<TopologyBackend, "baseUrl" | "advertisedAddresses">,
): string[] {
  const explicit = (row.advertisedAddresses ?? [])
    .map((a) => normalizeMaster(a))
    .filter((a) => a.length > 0);
  if (explicit.length > 0) return [...new Set(explicit)];
  const host = hostFromUrl(row.baseUrl);
  return host ? [normalizeMaster(host)] : [];
}

/**
 * Resolve which managed backend(s) a set of `masters[]` points to. Matched
 * backends are the AXFR upstreams we manage; `external` lists the addresses
 * that didn't match any managed backend (unmanaged/external primaries).
 */
export function resolveUpstreams(
  masters: readonly string[],
  backends: readonly TopologyBackend[],
): { matched: TopologyBackend[]; external: string[] } {
  const index = new Map<string, TopologyBackend>();
  for (const b of backends) {
    for (const addr of advertisedAddressesFor(b)) {
      if (!index.has(addr)) index.set(addr, b);
    }
  }
  const matched: TopologyBackend[] = [];
  const seenBackends = new Set<string>();
  const external: string[] = [];
  const seenExternal = new Set<string>();
  for (const raw of masters) {
    const norm = normalizeMaster(raw);
    if (norm === "") continue;
    const hit = index.get(norm);
    if (hit) {
      if (!seenBackends.has(hit.id)) {
        seenBackends.add(hit.id);
        matched.push(hit);
      }
    } else if (!seenExternal.has(norm)) {
      seenExternal.add(norm);
      external.push(norm);
    }
  }
  return { matched, external };
}
