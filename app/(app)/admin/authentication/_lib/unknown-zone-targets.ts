/**
 * Zone-scoped group mappings whose zone is not served by any backend. Read
 * from the broker's zone cache (no PDNS calls of its own); reports nothing
 * unless every enabled backend's zone list is known.
 */

import "server-only";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { readCachedZones } from "@/lib/pdns/zone-state-cache";
import { unknownZoneTargets, type GroupMappingRow } from "@/lib/validators/group-mappings";

export async function unknownZoneTargetsFor(
  mappings: ReadonlyArray<Pick<GroupMappingRow, "scopeType" | "scopeId">> | null,
  servers: ReadonlyArray<{ id: string; disabledAt: Date | null }>,
): Promise<string[]> {
  if (!mappings?.some((m) => m.scopeType === "zone")) return [];
  await ensureBackendsObserved();
  const known = new Set<string>();
  for (const server of servers) {
    if (server.disabledAt !== null) continue;
    const cached = readCachedZones(server.id);
    if (!cached) return [];
    for (const name of cached.zones.keys()) known.add(name);
  }
  return unknownZoneTargets(mappings, known);
}
