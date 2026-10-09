/**
 * lib/pdns/topology-resolve.ts
 *
 * DNS-resolving extension of the pure `topology.ts` matcher (ADR-0014). A
 * mirror zone's `masters[]` holds DNS-layer addresses (usually IPs), while a
 * backend's advertised address often defaults to its API hostname - so a string
 * compare misses (the "API host ≠ DNS IP" caveat). Here we resolve hostnames to
 * IPs (cached, best-effort) on both sides so a `masters[]` IP can match an
 * advertised hostname. This is what lets a primary+secondaries group's sync be
 * derived from `masters[]` without the operator hand-setting advertised IPs.
 *
 * Server-only (does DNS). The matching is parameterized on a `Resolver` so the
 * pure logic is unit-testable with a fake, and the default resolver is built by
 * {@link createCachingResolver} so its cache and timeout are testable too.
 */

import "server-only";
import { lookup } from "node:dns/promises";
import { advertisedAddressesFor, normalizeMaster } from "./topology";

/** Resolve a hostname to IPs. Injectable so tests don't hit real DNS. */
export type Resolver = (host: string) => Promise<string[]>;

/** The slice of `node:dns/promises` the caching resolver needs. */
export type LookupAll = (host: string) => Promise<ReadonlyArray<{ address: string }>>;

export interface CachingResolverOptions {
  /** How long a resolution (positive or negative) is reused. */
  ttlMs?: number;
  /**
   * Upper bound on one lookup. `node:dns.lookup` has no timeout of its own
   * (it inherits the resolver's, typically 5 s × retries), and the poll cycle
   * awaits these sequentially - one stalled resolver stalled the whole cycle.
   */
  timeoutMs?: number;
  /** Maximum distinct hosts kept; the least recently refreshed are evicted. */
  maxEntries?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const DEFAULT_DNS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ENTRIES = 512;

function looksLikeIp(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s) || s.includes(":");
}

/**
 * Build a best-effort resolver (empty list on failure or timeout) with a
 * bounded, expiring cache. Expired entries are dropped whenever the cache is
 * consulted and the oldest entry is evicted once `maxEntries` is reached, so
 * a backend fleet whose hostnames churn (re-provisioned containers, ephemeral
 * masters) can't grow the map without bound.
 */
export function createCachingResolver(
  lookupAll: LookupAll,
  options: CachingResolverOptions = {},
): Resolver & { size: () => number } {
  const ttlMs = options.ttlMs ?? DEFAULT_DNS_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  // Insertion order doubles as refresh order: `set` after `delete` moves the
  // key to the end, so the first key is always the stalest.
  const cache = new Map<string, { ips: string[]; at: number }>();

  const sweepExpired = (at: number): void => {
    for (const [host, entry] of cache) {
      if (at - entry.at >= ttlMs) cache.delete(host);
    }
  };

  const remember = (host: string, ips: string[], at: number): void => {
    cache.delete(host);
    if (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(host, { ips, at });
  };

  const resolve: Resolver = async (host) => {
    if (host === "") return [];
    if (looksLikeIp(host)) return [host];
    const at = now();
    sweepExpired(at);
    const cached = cache.get(host);
    if (cached) return cached.ips;
    const ips = await withTimeout(lookupAll(host), timeoutMs)
      .then((records) => records.map((r) => r.address))
      .catch(() => []);
    remember(host, ips, now());
    return ips;
  };

  return Object.assign(resolve, { size: () => cache.size });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(`dns lookup timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        rejectPromise(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/** Default resolver: node DNS lookup, cached + bounded + best-effort. */
const dnsResolve: Resolver = createCachingResolver((host) => lookup(host, { all: true }));

/**
 * A backend's advertised DNS addresses plus their resolved IPs - the set a
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
