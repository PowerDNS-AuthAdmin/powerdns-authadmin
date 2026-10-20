/**
 * app/api/admin/pdns/auto-ptr/_scan.ts
 *
 * Reads every zone on every active backend once and sorts the records the
 * Reverse DNS page cares about: A/AAAA records of forward zones, PTR RRsets of
 * reverse zones, and which reverse zones are hosted (and writable) where.
 *
 * This is a full read of the fleet by design - there is no PowerDNS API for
 * "every A record anywhere" - so it runs on demand from the page, a few zones
 * at a time per backend, and never from a timer. Cluster peers share one
 * database, so one peer per cluster is read.
 */

import type { PdnsServer } from "@/lib/db/schema";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import type {
  ForwardAddressRecord,
  HostedReverseZoneInfo,
  ReversePtrRecord,
} from "@/lib/dns/ptr-reconcile";
import { canonicalZone } from "@/lib/dns/reverse-name";
import { zoneKind } from "@/lib/dns/zone-kind";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { isReadOnlyZoneKind } from "@/lib/pdns/writable-kind";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";

export interface FleetScan {
  /** When the scan finished (epoch ms). */
  at: number;
  backends: Array<{ slug: string; name: string }>;
  servers: PdnsServer[];
  forward: ForwardAddressRecord[];
  reverse: ReversePtrRecord[];
  hostedReverseZones: HostedReverseZoneInfo[];
  zonesScanned: number;
  recordsScanned: number;
  errors: Array<{ server: string; zone?: string; message: string }>;
}

const ZONE_CONCURRENCY = 4;

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function scanFleet(): Promise<FleetScan> {
  const all = await listAllActiveBackends();
  // One reader per cluster: every peer serves the same zones.
  const seenClusters = new Set<string>();
  const servers = all.filter((s) => {
    if (!s.clusterId) return true;
    if (seenClusters.has(s.clusterId)) return false;
    seenClusters.add(s.clusterId);
    return true;
  });

  const scan: FleetScan = {
    at: 0,
    backends: all.map((s) => ({ slug: s.slug, name: s.name })),
    servers: all,
    forward: [],
    reverse: [],
    hostedReverseZones: [],
    zonesScanned: 0,
    recordsScanned: 0,
    errors: [],
  };

  await Promise.all(
    servers.map(async (server) => {
      const client = getBackendGateway(server);
      let zones: Array<{ name: string; kind: string }>;
      const cached = readCachedZones(server.id);
      if (cached) {
        zones = [...cached.zones.values()];
      } else {
        try {
          zones = await client.listZones();
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : "unknown";
          scan.errors.push({ server: server.slug, message });
          logger.warn({ server: server.slug, error: message }, "auto-ptr.scan.list-zones.failed");
          return;
        }
      }
      const writable = server.writeMode !== "read_only";
      await eachLimited(zones, ZONE_CONCURRENCY, async (z) => {
        const name = canonicalZone(z.name);
        const kind = zoneKind(name);
        if (kind !== "forward") {
          scan.hostedReverseZones.push({
            name,
            server: server.slug,
            writable: writable && !isReadOnlyZoneKind(z.kind),
          });
        }
        let detail;
        try {
          detail = await client.getZone(name);
        } catch (err) {
          const message = err instanceof Error ? redact(err.message) : "unknown";
          scan.errors.push({ server: server.slug, zone: name, message });
          return;
        }
        scan.zonesScanned++;
        for (const rr of detail.rrsets ?? []) {
          if (kind === "forward" && (rr.type === "A" || rr.type === "AAAA")) {
            for (const r of rr.records) {
              scan.recordsScanned++;
              scan.forward.push({
                zone: name,
                server: server.slug,
                name: rr.name.toLowerCase(),
                type: rr.type,
                ttl: rr.ttl,
                disabled: r.disabled === true,
                content: r.content,
              });
            }
          } else if (kind !== "forward" && rr.type === "PTR") {
            scan.recordsScanned++;
            scan.reverse.push({
              zone: name,
              server: server.slug,
              owner: rr.name.toLowerCase(),
              ttl: rr.ttl,
              targets: rr.records.map((r) => r.content),
            });
          }
        }
      });
    }),
  );
  scan.at = Date.now();
  return scan;
}

/* ---------------------------------------------------------------- cache */

declare global {
  var __pdnsFleetScanCache:
    | { at: number; scan: FleetScan; inFlight: Promise<FleetScan> | null }
    | undefined;
}
const cache = (globalThis.__pdnsFleetScanCache ??= {
  at: 0,
  scan: null as unknown as FleetScan,
  inFlight: null,
});

/** Youngest a cached scan may be for `refresh` to force a new one. */
export const MIN_REFRESH_INTERVAL_MS = 15_000;
/** How long the Reverse DNS page and the record-table link chips reuse a scan. */
export const DEFAULT_SCAN_MAX_AGE_MS = 60_000;

/**
 * The fleet scan, shared and deduplicated: concurrent callers join one
 * in-flight scan instead of each reading every zone, and a scan younger than
 * `maxAgeMs` is reused. One entry, so memory stays bounded by one fleet's
 * worth of A/AAAA/PTR rows. `refresh` asks for a fresh read but is ignored
 * while the last one is younger than MIN_REFRESH_INTERVAL_MS, which keeps a
 * reload-happy operator (or a script) from turning the page into a backend
 * load test.
 */
export async function getFleetScan(
  opts: { maxAgeMs?: number; refresh?: boolean } = {},
): Promise<FleetScan> {
  const maxAge = opts.maxAgeMs ?? DEFAULT_SCAN_MAX_AGE_MS;
  const age = Date.now() - cache.at;
  const fresh = cache.scan && age < (opts.refresh ? MIN_REFRESH_INTERVAL_MS : maxAge);
  if (fresh) return cache.scan;
  if (cache.inFlight) return cache.inFlight;
  cache.inFlight = scanFleet()
    .then((scan) => {
      cache.scan = scan;
      cache.at = Date.now();
      return scan;
    })
    .finally(() => {
      cache.inFlight = null;
    });
  return cache.inFlight;
}

/** Forget the cached scan: a PTR was just written, so the next read must see it. */
export function invalidateFleetScan(): void {
  cache.at = 0;
}
