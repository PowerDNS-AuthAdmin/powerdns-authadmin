/**
 * lib/pdns/topology-resolve.ts
 *
 * DNS-resolving extension of the pure `topology.ts` matcher (ADR-0014). A
 * mirror zone's `masters[]` holds DNS-layer addresses (usually IPs), while a
 * backend's advertised address often defaults to its API hostname — so a string
 * compare misses (the "API host ≠ DNS IP" caveat). Here we resolve hostnames to
 * IPs (cached, best-effort) on both sides so a `masters[]` IP can match an
 * advertised hostname. This is what lets a primary+secondaries group's sync be
 * derived from `masters[]` without the operator hand-setting advertised IPs.
 *
 * Server-only (does DNS). The matching is parameterized on a `Resolver` so the
 * pure logic is unit-testable with a fake.
 */

import "server-only";
import { lookup } from "node:dns/promises";
import { advertisedAddressesFor, normalizeMaster } from "./topology";

/** Resolve a hostname to IPs. Injectable so tests don't hit real DNS. */
export type Resolver = (host: string) => Promise<string[]>;

const DNS_TTL_MS = 5 * 60 * 1000;
const dnsCache = new Map<string, { ips: string[]; at: number }>();

function looksLikeIp(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
}

/** Default resolver: node DNS lookup, cached + best-effort (empty on failure). */
async function dnsResolve(host: string): Promise<string[]> {
  if (host === "") return [];
  if (looksLikeIp(host)) return [host];
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL_MS) return cached.ips;
  try {
    const ips = (await lookup(host, { all: true })).map((r) => r.address);
    dnsCache.set(host, { ips, at: Date.now() });
    return ips;
  } catch {
    dnsCache.set(host, { ips: [], at: Date.now() });
    return [];
  }
}

/**
 * A backend's advertised DNS addresses plus their resolved IPs — the set a
 * mirror zone's `masters[]` is matched against.
 */
export async function backendAddressSet(
  backend: { baseUrl: string; advertisedAddresses: string[] | null },
  resolve: Resolver = dnsResolve,
): Promise<Set<string>> {
  const set = new Set<string>();
  for (const addr of advertisedAddressesFor(backend)) {
    set.add(addr);
    for (const ip of await resolve(addr)) set.add(ip);
  }
  return set;
}

/** Whether any `masters[]` entry points at the given backend address set. */
export async function mastersPointAt(
  masters: readonly string[],
  addrSet: ReadonlySet<string>,
  resolve: Resolver = dnsResolve,
): Promise<boolean> {
  for (const raw of masters) {
    const norm = normalizeMaster(raw);
    if (norm === "") continue;
    if (addrSet.has(norm)) return true;
    if (!looksLikeIp(norm)) {
      for (const ip of await resolve(norm)) if (addrSet.has(ip)) return true;
    }
  }
  return false;
}

/**
 * Resolve a mirror zone's `masters[]` to a backend id via an `address → id`
 * index (the poller builds the index once from every primary's resolved
 * addresses, then looks up each mirror zone's masters in O(1)). First match
 * wins. Hostname masters are DNS-resolved against the index.
 */
export async function resolveMastersToBackendId(
  masters: readonly string[],
  index: ReadonlyMap<string, string>,
  resolve: Resolver = dnsResolve,
): Promise<string | null> {
  for (const raw of masters) {
    const norm = normalizeMaster(raw);
    if (norm === "") continue;
    const direct = index.get(norm);
    if (direct) return direct;
    if (!looksLikeIp(norm)) {
      for (const ip of await resolve(norm)) {
        const hit = index.get(ip);
        if (hit) return hit;
      }
    }
  }
  return null;
}
