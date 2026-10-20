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
import {
  horizonFrom,
  horizonScopeFor,
  loadZoneHorizonIndex,
} from "@/lib/db/repositories/zone-horizons";
import { ipFromReverseOwner, parseIp } from "@/lib/dns/reverse-name";
import type { ZoneHorizon } from "@/lib/dns/zone-horizon";
import { classifyAddress } from "@/lib/net/url-safety";
import { parseSoaContent } from "@/lib/validators/soa";
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
import type { PdnsClient } from "@/lib/pdns/client";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";

/** The apex facts zone monitoring needs about one zone, from its PowerDNS copy. */
export interface ScannedZone {
  name: string;
  server: string;
  horizon: ZoneHorizon;
  kind: string;
  dnssec: boolean;
  serial: number | null;
  soa: {
    mname: string;
    rname: string;
    serial: number;
    refresh: number;
    retry: number;
    expire: number;
    minimum: number;
  } | null;
  nsNames: string[];
  /** A/AAAA the zone holds for its own in-bailiwick nameservers. */
  glue: Record<string, string[]>;
}

export interface FleetScan {
  /** When the scan finished (epoch ms). */
  at: number;
  zones: ScannedZone[];
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

type ZoneDetailLike = Awaited<ReturnType<PdnsClient["getZone"]>>;

interface CachedZoneDetail {
  stamp: string;
  detail: ZoneDetailLike;
}
declare global {
  var __pdnsZoneDetailCache: Map<string, CachedZoneDetail> | undefined;
}
/** Last full read of each zone, keyed by backend id + zone, stamped with serial|edited_serial. */
const detailCache: Map<string, CachedZoneDetail> = (globalThis.__pdnsZoneDetailCache ??= new Map<
  string,
  CachedZoneDetail
>());

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
    zones: [],
    forward: [],
    reverse: [],
    hostedReverseZones: [],
    zonesScanned: 0,
    recordsScanned: 0,
    errors: [],
  };

  const horizons = await loadZoneHorizonIndex();
  const liveKeys = new Set<string>();
  await Promise.all(
    servers.map(async (server) => {
      const client = getBackendGateway(server);
      const scope = horizonScopeFor(server);
      let zones: Array<{
        name: string;
        kind: string;
        serial?: number | null;
        editedSerial?: number | null;
      }>;
      const cachedList = readCachedZones(server.id);
      if (cachedList) {
        zones = [...cachedList.zones.values()];
      } else {
        try {
          zones = (await client.listZones()).map((z) => ({
            name: z.name,
            kind: z.kind,
            serial: z.serial ?? null,
            editedSerial: z.edited_serial ?? null,
          }));
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
        const detailKey = `${server.id}|${name}`;
        const stamp = `${z.serial ?? ""}|${z.editedSerial ?? ""}`;
        const kind = zoneKind(name);
        const horizon = effectiveHorizon(
          name,
          kind !== "forward",
          horizonFrom(horizons, scope, name),
        );
        if (kind !== "forward") {
          scan.hostedReverseZones.push({
            name,
            server: server.slug,
            writable: writable && !isReadOnlyZoneKind(z.kind),
            horizon,
          });
        }
        // Reuse the last read when the listing's serial has not moved: a rescan
        // then costs one list call per backend plus the zones that changed, which
        // is what keeps the Reverse DNS page quick on a fleet of hundreds of zones.
        const cached = detailCache.get(detailKey);
        let detail: ZoneDetailLike;
        if (cached?.stamp === stamp && stamp !== "|") {
          detail = cached.detail;
        } else {
          try {
            detail = await client.getZone(name);
          } catch (err) {
            const message = err instanceof Error ? redact(err.message) : "unknown";
            scan.errors.push({ server: server.slug, zone: name, message });
            return;
          }
          detailCache.set(detailKey, { stamp, detail });
        }
        liveKeys.add(detailKey);
        scan.zonesScanned++;
        scan.zones.push(apexFacts(name, server.slug, horizon, detail));
        for (const rr of detail.rrsets ?? []) {
          if (kind === "forward" && (rr.type === "A" || rr.type === "AAAA")) {
            for (const r of rr.records) {
              scan.recordsScanned++;
              scan.forward.push({
                zone: name,
                server: server.slug,
                horizon,
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
              horizon,
              owner: rr.name.toLowerCase(),
              ttl: rr.ttl,
              targets: rr.records.map((r) => r.content),
            });
          }
        }
      });
    }),
  );
  // Zones that disappeared from every listing leave the detail cache too.
  for (const k of [...detailCache.keys()]) if (!liveKeys.has(k)) detailCache.delete(k);
  scan.at = Date.now();
  return scan;
}

/**
 * A reverse zone that covers private address space is internal whatever the
 * operator forgot to classify; a public tree stays public. Forward zones follow
 * their classification (public by default, ADR-0022).
 */
function effectiveHorizon(zone: string, reverse: boolean, classified: ZoneHorizon): ZoneHorizon {
  if (!reverse || classified === "internal") return classified;
  const sample = ipFromReverseOwner(firstOwnerIn(zone));
  if (sample && classifyAddress(sample) === "private") return "internal";
  return classified;
}

/** `2.0.192.in-addr.arpa.` → `0.2.0.192.in-addr.arpa.`; ip6 zones padded with zero nibbles. */
function firstOwnerIn(zone: string): string {
  if (zone.endsWith(".ip6.arpa.")) {
    const nibbles = zone
      .replace(/\.ip6\.arpa\.$/, "")
      .split(".")
      .filter(Boolean);
    const pad = Array.from({ length: Math.max(0, 32 - nibbles.length) }, () => "0");
    return `${[...pad, ...nibbles].join(".")}.ip6.arpa.`;
  }
  const labels = zone
    .replace(/\.in-addr\.arpa\.$/, "")
    .split(".")
    .filter(Boolean);
  const pad = Array.from({ length: Math.max(0, 4 - labels.length) }, () => "0");
  return `${[...pad, ...labels].join(".")}.in-addr.arpa.`;
}

const fqdn = (name: string): string => name.toLowerCase().replace(/\.?$/, ".");

function apexFacts(
  name: string,
  server: string,
  horizon: ZoneHorizon,
  detail: {
    kind?: string;
    dnssec?: boolean;
    serial?: number | null;
    rrsets?: Array<{
      name: string;
      type: string;
      records: Array<{ content: string; disabled?: boolean }>;
    }>;
  },
): ScannedZone {
  const rrsets = detail.rrsets ?? [];
  const apex = (type: string) =>
    rrsets.find((rr) => rr.name.toLowerCase() === name && rr.type === type);
  const nsNames = (apex("NS")?.records ?? [])
    .filter((r) => !r.disabled)
    .map((r) => fqdn(r.content));
  let soa: ScannedZone["soa"] = null;
  const soaContent = apex("SOA")?.records[0]?.content;
  if (soaContent) {
    try {
      const parsed = parseSoaContent(soaContent);
      soa = { ...parsed, mname: fqdn(parsed.mname), rname: fqdn(parsed.rname) };
    } catch {
      soa = null; // reported as soa.missing by the checks
    }
  }
  const glue: Record<string, string[]> = {};
  for (const ns of nsNames) {
    if (ns !== name && !ns.endsWith(`.${name}`)) continue;
    for (const rr of rrsets) {
      if (rr.name.toLowerCase() !== ns || (rr.type !== "A" && rr.type !== "AAAA")) continue;
      for (const r of rr.records)
        if (!r.disabled && parseIp(r.content)) (glue[ns] ??= []).push(r.content);
    }
  }
  return {
    name,
    server,
    horizon,
    kind: detail.kind ?? "",
    dnssec: detail.dnssec === true,
    serial: typeof detail.serial === "number" ? detail.serial : (soa?.serial ?? null),
    soa,
    nsNames,
    glue,
  };
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
export const MIN_REFRESH_INTERVAL_MS = 5_000;
/** How long the Reverse DNS page and the record-table link chips reuse a scan. */
export const DEFAULT_SCAN_MAX_AGE_MS = 20_000;

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

/** The last scan without triggering one (null before the first). */
export function peekFleetScan(): FleetScan | null {
  return cache.scan ?? null;
}
