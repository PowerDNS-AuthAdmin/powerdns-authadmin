/**
 * lib/db/repositories/zone-grants.ts
 *
 * Read path for zone_grants — the lookups the ability-builder uses (via a
 * wrapper at the auth layer). Grant create/revoke runs in the admin route
 * handlers, not here.
 *
 * Zone-name canonicalization lives at the route layer — readers
 * here trust the DB column to be lowercase + trailing-dot already.
 */

import "server-only";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { zoneGrants, pdnsServers, type ZoneGrant } from "@/lib/db/schema";

/**
 * Every zone grant the given user has, across all backends. Used by
 * the ability builder to fold per-zone permissions into the user's
 * effective ability for a request that touches a specific zone.
 *
 * Ordered by (server_id, zone_name) so callers building lookup maps
 * get stable iteration; the unique index on (user, server, zone)
 * means no duplicates can exist.
 */
export async function listGrantsForUser(userId: string): Promise<ZoneGrant[]> {
  return db
    .select()
    .from(zoneGrants)
    .where(eq(zoneGrants.userId, userId))
    .orderBy(zoneGrants.serverId, zoneGrants.zoneName);
}

/**
 * Single-grant lookup keyed by the unique (user, server, zone) tuple.
 * Returns null when no grant exists. The most-likely caller is the
 * upcoming permission gate inside specific zone routes, not the
 * generic ability builder (which prefers `listGrantsForUser` and
 * builds a map once per request).
 */
export async function findGrant(input: {
  userId: string;
  serverId: string;
  zoneName: string;
}): Promise<ZoneGrant | null> {
  const rows = await db
    .select()
    .from(zoneGrants)
    .where(
      and(
        eq(zoneGrants.userId, input.userId),
        eq(zoneGrants.serverId, input.serverId),
        eq(zoneGrants.zoneName, input.zoneName),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * For each of the given server ids that belongs to a cluster, the full set of
 * server ids in that cluster (including itself). Servers not in a cluster
 * (standalone primaries, primary+secondaries groups) are omitted — callers
 * treat an absent key as "just this server".
 *
 * Feeds `expandGrantsAcrossClusters` (lib/rbac/zone-permissions): a zone grant
 * issued on one peer of a multi-primary cluster must authorize the zone on every
 * peer, because the request path resolves a rotating peer via `choosePeer`.
 *
 * Two small dialect-neutral queries instead of a self-join (the repo's `db` is
 * the shared pg/sqlite handle; a self-join needs dialect-specific aliasing).
 */
export async function mapServersToClusterPeers(
  serverIds: readonly string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (serverIds.length === 0) return result;

  // Which of the requested servers are in a cluster, and which cluster?
  const inputRows = await db
    .select({ id: pdnsServers.id, clusterId: pdnsServers.clusterId })
    .from(pdnsServers)
    .where(inArray(pdnsServers.id, [...serverIds]));
  const clusterIds = [
    ...new Set(inputRows.map((r) => r.clusterId).filter((c): c is string => c !== null)),
  ];
  if (clusterIds.length === 0) return result;

  // Every server in those clusters.
  const peerRows = await db
    .select({ id: pdnsServers.id, clusterId: pdnsServers.clusterId })
    .from(pdnsServers)
    .where(and(inArray(pdnsServers.clusterId, clusterIds), isNotNull(pdnsServers.clusterId)));
  const peersByCluster = new Map<string, string[]>();
  for (const r of peerRows) {
    if (r.clusterId === null) continue;
    const arr = peersByCluster.get(r.clusterId) ?? [];
    arr.push(r.id);
    peersByCluster.set(r.clusterId, arr);
  }

  for (const r of inputRows) {
    if (r.clusterId === null) continue;
    result.set(r.id, peersByCluster.get(r.clusterId) ?? [r.id]);
  }
  return result;
}
