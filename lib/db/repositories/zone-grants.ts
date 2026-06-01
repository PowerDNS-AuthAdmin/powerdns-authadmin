/**
 * lib/db/repositories/zone-grants.ts
 *
 * Read path for zone_grants - the lookups the ability-builder uses (via a
 * wrapper at the auth layer). Grant create/revoke runs in the admin route
 * handlers, not here.
 *
 * `zone_grants` is a discriminated table: each row is keyed on either
 * `user_id` (direct user grant) or `team_id` (team grant flowing through
 * to every member of the team via `team_members`). Exactly one is non-null,
 * enforced at the DB by `zone_grants_principal_check`.
 *
 * Zone-name canonicalization lives at the route layer - readers
 * here trust the DB column to be lowercase + trailing-dot already.
 */

import "server-only";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { pdnsServers, teamMembers, teams, users, zoneGrants } from "@/lib/db/schema";
import type { ZoneGrant } from "@/lib/db/schema";

/**
 * Every zone grant the given user effectively holds, across all backends
 * - direct user grants UNION'd with team grants from every team the user
 * is a member of. This is what the ability-builder folds into the request
 * ability via `canActOnZone`; a record-write on a zone owned by team T is
 * authorized when *either* a direct user grant *or* a team-T grant covers
 * the permission.
 *
 * Ordered by (server_id, zone_name) so callers building lookup maps get
 * stable iteration. Duplicates can occur (the same user holds a direct
 * grant AND inherits a team grant on the same zone) - the ability-builder
 * already UNIONs permission sets so this is harmless.
 */
export async function listGrantsForUser(userId: string): Promise<ZoneGrant[]> {
  // Sub-select: every team the user is a member of. Materialised inline so
  // we issue one SQL round-trip instead of two; team_members is small
  // relative to zone_grants, the planner handles the IN cheaply.
  const memberOf = db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId));

  return db
    .select()
    .from(zoneGrants)
    .where(or(eq(zoneGrants.userId, userId), inArray(zoneGrants.teamId, memberOf)))
    .orderBy(zoneGrants.serverId, zoneGrants.zoneName);
}

/**
 * Direct user grants only - no team-inherited rows. Used by the admin user-
 * detail UI, which lets the operator edit *this user's own* grants and must
 * not show inherited rows as if they were editable on this page.
 */
export async function listDirectGrantsForUser(userId: string): Promise<ZoneGrant[]> {
  return db
    .select()
    .from(zoneGrants)
    .where(eq(zoneGrants.userId, userId))
    .orderBy(zoneGrants.serverId, zoneGrants.zoneName);
}

/**
 * Every grant attached to a team. Used by the admin team-detail UI's
 * "Zone grants" tab - the operator edits team grants from there.
 */
export async function listGrantsForTeam(teamId: string): Promise<ZoneGrant[]> {
  return db
    .select()
    .from(zoneGrants)
    .where(eq(zoneGrants.teamId, teamId))
    .orderBy(zoneGrants.serverId, zoneGrants.zoneName);
}

/**
 * A grant row enriched with its principal (user OR team) - used by the
 * zone-detail "Access" tab to render a single combined list without an
 * N+1 lookup per row.
 */
export interface GrantWithPrincipal {
  id: string;
  permissions: readonly string[];
  createdAt: Date;
  createdBy: string | null;
  user: { id: string; email: string; name: string | null } | null;
  team: { id: string; slug: string; name: string } | null;
}

/**
 * Every grant pointing at a specific (server, zone). Joined out to user/team
 * metadata so the caller doesn't need a second round-trip per row. Exactly
 * one of `user` / `team` is set per row (the DB check guarantees it).
 */
export async function listGrantsForZone(input: {
  serverId: string;
  zoneName: string;
}): Promise<GrantWithPrincipal[]> {
  const rows = await db
    .select({
      id: zoneGrants.id,
      permissions: zoneGrants.permissions,
      createdAt: zoneGrants.createdAt,
      createdBy: zoneGrants.createdBy,
      userId: zoneGrants.userId,
      userEmail: users.email,
      userDisplayName: users.name,
      teamId: zoneGrants.teamId,
      teamSlug: teams.slug,
      teamName: teams.name,
    })
    .from(zoneGrants)
    .leftJoin(users, eq(users.id, zoneGrants.userId))
    .leftJoin(teams, eq(teams.id, zoneGrants.teamId))
    .where(and(eq(zoneGrants.serverId, input.serverId), eq(zoneGrants.zoneName, input.zoneName)));

  return rows.map((r) => ({
    id: r.id,
    permissions: r.permissions,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    user:
      r.userId && r.userEmail
        ? { id: r.userId, email: r.userEmail, name: r.userDisplayName }
        : null,
    team:
      r.teamId && r.teamName && r.teamSlug
        ? { id: r.teamId, slug: r.teamSlug, name: r.teamName }
        : null,
  }));
}

/**
 * Single-user-grant lookup keyed by the unique (user, server, zone) tuple.
 * Returns null when no grant exists. Used by the create-grant route to
 * surface a friendlier conflict than the raw constraint violation.
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
 * Single-team-grant lookup. Mirror of `findGrant` for team principals.
 */
export async function findTeamGrant(input: {
  teamId: string;
  serverId: string;
  zoneName: string;
}): Promise<ZoneGrant | null> {
  const rows = await db
    .select()
    .from(zoneGrants)
    .where(
      and(
        eq(zoneGrants.teamId, input.teamId),
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
 * (standalone primaries, primary+secondaries groups) are omitted - callers
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
