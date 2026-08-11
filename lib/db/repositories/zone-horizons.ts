/**
 * lib/db/repositories/zone-horizons.ts
 *
 * Read + write path for `zone_horizons` - the per-zone "this is the internal
 * copy" classification (ADR-0022, #121).
 *
 * Storage is sparse: only a non-default horizon has a row, so `setZoneHorizon`
 * DELETEs when the operator clears the flag rather than writing `public` back.
 * Readers therefore never distinguish "explicitly public" from "unclassified" -
 * both answer `public`, which is the whole point of the default.
 *
 * A zone is scoped to either a standalone server or a cluster, never both;
 * `HorizonScope` makes that unrepresentable in TypeScript, and a DB CHECK backs
 * it up. Callers resolve the scope from the backend they already have: a server
 * whose `clusterId` is set belongs to the cluster, not to the peer.
 *
 * Zone-name canonicalization (lowercase + trailing dot) happens at the route
 * layer, matching `zone_grants`; readers here trust the column.
 */

import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { zoneHorizons } from "@/lib/db/schema";
import { DEFAULT_ZONE_HORIZON, type ZoneHorizon } from "@/lib/dns/zone-horizon";

/** Which backend a classification belongs to. Exactly one of the two. */
export type HorizonScope = { serverId: string } | { clusterId: string };

/**
 * Resolve the scope for a backend row. A server that belongs to a cluster
 * classifies against the CLUSTER: cluster reads/writes rotate peers per
 * request, so a flag stored against one peer would flicker.
 */
export function horizonScopeFor(server: { id: string; clusterId: string | null }): HorizonScope {
  return server.clusterId ? { clusterId: server.clusterId } : { serverId: server.id };
}

/** Stable lookup key for an in-memory index of classifications. */
export function horizonKey(scope: HorizonScope, zoneName: string): string {
  return "serverId" in scope
    ? JSON.stringify(["server", scope.serverId, zoneName])
    : JSON.stringify(["cluster", scope.clusterId, zoneName]);
}

/** Every stored classification, indexed by {@link horizonKey}. */
export type ZoneHorizonIndex = ReadonlyMap<string, ZoneHorizon>;

/**
 * Load every classification in one query and index it for in-memory lookup.
 * The amalgamated zones list needs the horizon of every row it renders; the
 * table holds one row per deliberately-classified zone (single digits to low
 * hundreds in practice), so a full read beats N per-zone queries by a wide
 * margin.
 */
export async function loadZoneHorizonIndex(): Promise<ZoneHorizonIndex> {
  const rows = await db
    .select({
      serverId: zoneHorizons.serverId,
      clusterId: zoneHorizons.clusterId,
      zoneName: zoneHorizons.zoneName,
      horizon: zoneHorizons.horizon,
    })
    .from(zoneHorizons);

  const index = new Map<string, ZoneHorizon>();
  for (const row of rows) {
    const scope: HorizonScope | null = row.serverId
      ? { serverId: row.serverId }
      : row.clusterId
        ? { clusterId: row.clusterId }
        : null;
    // Unreachable while the CHECK holds; skip rather than throw so one bad row
    // can't take down the whole zones list.
    if (!scope) continue;
    index.set(horizonKey(scope, row.zoneName), row.horizon);
  }
  return index;
}

/** Look a zone up in a loaded index, falling back to the default horizon. */
export function horizonFrom(
  index: ZoneHorizonIndex,
  scope: HorizonScope,
  zoneName: string,
): ZoneHorizon {
  return index.get(horizonKey(scope, zoneName)) ?? DEFAULT_ZONE_HORIZON;
}

function scopeCondition(scope: HorizonScope) {
  return "serverId" in scope
    ? and(eq(zoneHorizons.serverId, scope.serverId), isNull(zoneHorizons.clusterId))
    : and(eq(zoneHorizons.clusterId, scope.clusterId), isNull(zoneHorizons.serverId));
}

/** The horizon of one zone. `public` when unclassified. */
export async function getZoneHorizon(scope: HorizonScope, zoneName: string): Promise<ZoneHorizon> {
  const [row] = await db
    .select({ horizon: zoneHorizons.horizon })
    .from(zoneHorizons)
    .where(and(scopeCondition(scope), eq(zoneHorizons.zoneName, zoneName)))
    .limit(1);
  return row?.horizon ?? DEFAULT_ZONE_HORIZON;
}

/**
 * Classify a zone. Setting the default horizon removes the row - the table
 * records deviations, not every zone. Returns the horizon now in force so
 * callers can audit the transition without a re-read.
 *
 * Not wrapped in a transaction: the delete-then-insert path can only race with
 * another write to the SAME (scope, zone), where either order leaves exactly
 * one row (the partial unique index guarantees it) and last-write-wins is the
 * intended semantics for an operator toggle.
 */
export async function setZoneHorizon(input: {
  scope: HorizonScope;
  zoneName: string;
  horizon: ZoneHorizon;
  actorId: string | null;
}): Promise<ZoneHorizon> {
  const { scope, zoneName, horizon, actorId } = input;
  const where = and(scopeCondition(scope), eq(zoneHorizons.zoneName, zoneName));

  if (horizon === DEFAULT_ZONE_HORIZON) {
    await db.delete(zoneHorizons).where(where);
    return DEFAULT_ZONE_HORIZON;
  }

  const updated = await db
    .update(zoneHorizons)
    .set({ horizon, updatedAt: new Date() })
    .where(where)
    .returning({ id: zoneHorizons.id });
  if (updated.length > 0) return horizon;

  await db.insert(zoneHorizons).values({
    ...("serverId" in scope ? { serverId: scope.serverId } : { clusterId: scope.clusterId }),
    zoneName,
    horizon,
    createdBy: actorId,
  });
  return horizon;
}

/** Drop a zone's classification outright - used when the zone itself is deleted. */
export async function deleteZoneHorizon(scope: HorizonScope, zoneName: string): Promise<void> {
  await db
    .delete(zoneHorizons)
    .where(and(scopeCondition(scope), eq(zoneHorizons.zoneName, zoneName)));
}
