/**
 * lib/pdns/catalog-members.ts
 *
 * A catalog zone's members read live from its backend, for the one decision
 * that can't rest on the zone list: whether deleting a Producer zone needs
 * confirmation. PowerDNS 4.7 and 4.8 leave `catalog` empty in the zone list
 * (see `zoneListCarriesCatalog`), so there it is read zone by zone.
 */

import "server-only";
import { canonicalZoneName } from "@/lib/dns/zone-name";
import { catalogMembers, zoneListCarriesCatalog } from "./catalog";
import type { PdnsClient } from "./client";
import { isSystemKind } from "./zone-kinds";

/** How many single-zone reads run at once on a daemon whose list lacks `catalog`. */
const PER_ZONE_READ_CONCURRENCY = 8;

export interface LiveCatalogMembers {
  members: string[];
  /** False when a zone couldn't be read, so the count may be short. */
  complete: boolean;
}

export async function liveCatalogMembers(
  client: Pick<PdnsClient, "listZones" | "getZone" | "version">,
  catalog: string,
): Promise<LiveCatalogMembers> {
  const zones = await client.listZones();
  const { cache } = await client.version();
  if (zoneListCarriesCatalog(cache.parsed)) {
    return { members: catalogMembers(zones, catalog), complete: true };
  }

  const target = canonicalZoneName(catalog);
  const candidates = zones.filter((z) => !isSystemKind(z.kind));
  const members: string[] = [];
  let complete = true;
  for (let i = 0; i < candidates.length; i += PER_ZONE_READ_CONCURRENCY) {
    const batch = candidates.slice(i, i + PER_ZONE_READ_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((z) => client.getZone(z.name, { rrsets: false })),
    );
    for (const r of results) {
      if (r.status === "rejected") complete = false;
      else if (r.value.catalog && canonicalZoneName(r.value.catalog) === target) {
        members.push(canonicalZoneName(r.value.name));
      }
    }
  }
  return { members: members.sort(), complete };
}
