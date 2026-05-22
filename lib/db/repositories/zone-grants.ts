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
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { zoneGrants, type ZoneGrant } from "@/lib/db/schema";

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
