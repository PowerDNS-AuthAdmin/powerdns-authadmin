/**
 * lib/pdns/zone-state-cache.ts
 *
 * Short-lived (30 s) cache of every backend's zone list. The background
 * poller (`lib/realtime/zone-poller.ts`) writes here; the zones list
 * page reads from here. Cuts PDNS load + powers real-time event
 * emission: when the poller's fetch finds a delta vs. cached state,
 * it publishes a `zone.updated` event over the realtime bus.
 *
 * Keyed by `pdns_servers.id` (UUID). Survives HMR via globalThis.
 */

import "server-only";

const TTL_MS = 30_000;

export interface CachedZoneSnapshot {
  /** PDNS zone id (the URL-safe canonical zone, e.g. "example.com."). */
  id: string;
  /** PDNS zone name with trailing dot. */
  name: string;
  serial: number | null;
  editedSerial: number | null;
  notifiedSerial: number | null;
  kind: string;
  dnssec: boolean;
  /** AXFR source addresses for a mirror zone - drives derived topology. */
  masters: string[];
}

export interface CachedListEntry {
  fetchedAt: number;
  zones: Map<string, CachedZoneSnapshot>;
}

declare global {
  var __pdnsZoneStateCache: Map<string, CachedListEntry> | undefined;
}
const cache = (globalThis.__pdnsZoneStateCache ??= new Map<string, CachedListEntry>());

export function readCachedZones(serverDbId: string): CachedListEntry | null {
  const entry = cache.get(serverDbId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) return null;
  return entry;
}

export function writeCachedZones(serverDbId: string, zones: CachedZoneSnapshot[]): void {
  const map = new Map<string, CachedZoneSnapshot>();
  for (const z of zones) map.set(z.name, z);
  cache.set(serverDbId, { fetchedAt: Date.now(), zones: map });
}

/** Snapshot getter - handy for tests + the poller's diff. */
export function rawCache(): Map<string, CachedListEntry> {
  return cache;
}

/**
 * Lookup a single zone snapshot on a single backend. Null when the
 * cache is cold or this backend hasn't been polled within the TTL.
 */
export function readCachedZone(serverDbId: string, zoneName: string): CachedZoneSnapshot | null {
  const entry = readCachedZones(serverDbId);
  if (!entry) return null;
  return entry.zones.get(zoneName) ?? null;
}
