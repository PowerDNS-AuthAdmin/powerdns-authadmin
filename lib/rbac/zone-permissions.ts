/**
 * lib/rbac/zone-permissions.ts
 *
 * Folds `zone_grants` rows into the effective permission set for a
 * specific (server, zone). Pure - the storage shape (`{userId,
 * serverId, zoneName, permissions: string[]}`) is the same as what the
 * repo returns, but declared inline so this module doesn't take a
 * dependency on the DB layer (which would block unit tests under the
 * vitest worker that can't load `pg`).
 *
 * Why a separate helper instead of folding into `buildAbility`:
 *   - Zones in this app have no local team mapping, so a team/zone/
 *     server-scoped CASL rule on Zone/Record can't be evaluated against
 *     a real zone instance. Role-based zone access is therefore
 *     all-or-nothing (a GLOBAL grant), and fine-grained per-zone access
 *     is expressed by `zone_grants` rows instead.
 *
 * Effective permission for a (user, server, zone, action) is:
 *   - a role_assignment at GLOBAL scope that grants the action
 *     (`globalPermissionsOf` / the `hasGlobalPermission` arg), OR
 *   - any `zone_grants` row for this (user, server, zone) whose
 *     `permissions` list contains the action's full permission string.
 *
 * `effectiveZonePermissions` returns the Set so callers can do many
 * checks without re-iterating the grants array.
 */

export interface ZoneGrantInput {
  serverId: string;
  zoneName: string;
  permissions: readonly string[];
}

/**
 * Union of every permission granted on the given (server, zone) by the
 * supplied grants. Returns an empty set when no grant matches - the
 * caller decides what to do with that.
 *
 * `zoneName` is matched verbatim (case-sensitive, trailing-dot-aware)
 * because grants are stored canonicalized at write time. Callers should
 * canonicalize before calling.
 */
export function effectiveZonePermissions(
  grants: readonly ZoneGrantInput[],
  serverId: string,
  zoneName: string,
): Set<string> {
  const out = new Set<string>();
  for (const g of grants) {
    if (g.serverId !== serverId) continue;
    if (g.zoneName !== zoneName) continue;
    for (const p of g.permissions) out.add(p);
  }
  return out;
}

/**
 * Convenience for the common "does the user have this single
 * permission on this zone via a grant?" check. Equivalent to
 * `effectiveZonePermissions(...).has(permission)` but skips building
 * the full set when the answer is yes.
 */
export function hasZonePermissionViaGrant(
  grants: readonly ZoneGrantInput[],
  serverId: string,
  zoneName: string,
  permission: string,
): boolean {
  for (const g of grants) {
    if (g.serverId !== serverId) continue;
    if (g.zoneName !== zoneName) continue;
    if (g.permissions.includes(permission)) return true;
  }
  return false;
}

/**
 * The dual-check used by every zone-mutating route: a user is
 * authorized for an action on a specific zone if EITHER they hold the
 * permission at GLOBAL scope OR a `zone_grant` for THIS (server, zone)
 * includes the permission.
 *
 * `hasGlobalPermission` must be a *global*-scope decision
 * (`auth.globalPermissions.has(permission)`), NOT a type-level
 * `ability.can(action, "Type")` - the latter is true for
 * conditionally-scoped rules and would let a team/zone-scoped role act
 * on every zone. See `globalPermissionsOf` in `lib/rbac/ability.ts`.
 *
 * @example
 *   const allowed = canActOnZone({
 *     hasGlobalPermission: globalPermissions.has("metadata.write"),
 *     grants: zoneGrants,
 *     serverId: server.id,
 *     zoneName,
 *     permission: "metadata.write",
 *   });
 */
export function canActOnZone(input: {
  hasGlobalPermission: boolean;
  grants: readonly ZoneGrantInput[];
  serverId: string;
  zoneName: string;
  permission: string;
}): boolean {
  if (input.hasGlobalPermission) return true;
  return hasZonePermissionViaGrant(input.grants, input.serverId, input.zoneName, input.permission);
}

/**
 * Expand a user's grants across cluster peers so a grant issued on one peer of
 * a multi-primary cluster authorizes the zone on EVERY peer of that cluster.
 *
 * Grants are keyed to a single `serverId`, but a cluster zone's reads/writes
 * resolve a peer per request via `choosePeer` (round-robin / lowest-latency), so
 * a grant on peer A would intermittently 403 when peer B is chosen. We close
 * that by emitting, for each grant whose server belongs to a cluster, a copy of
 * the grant for every peer id in the same cluster - leaving the exact-`serverId`
 * matchers (`canActOnZone` et al.) and all their call sites untouched.
 *
 * `equivalentServerIds` maps a grant's `serverId` to every server id in its
 * cluster (built by `mapServersToClusterPeers`). A server absent from the map
 * (standalone, or not in a cluster) keeps its single grant verbatim.
 *
 * This is applied only on the AUTHZ path (`getCurrentUser`, the DynDNS token
 * path, the grant-ceiling check) - never on the admin DISPLAY path, where the
 * operator should see the real stored row, not synthetic per-peer copies.
 *
 * Pure: storage I/O (the cluster lookup) happens in the repo; this just maps.
 */
export function expandGrantsAcrossClusters<T extends { serverId: string }>(
  grants: readonly T[],
  equivalentServerIds: ReadonlyMap<string, readonly string[]>,
): T[] {
  const out: T[] = [];
  for (const g of grants) {
    const peers = equivalentServerIds.get(g.serverId);
    if (!peers || peers.length === 0) {
      out.push(g);
      continue;
    }
    for (const peerId of peers) {
      out.push(peerId === g.serverId ? g : { ...g, serverId: peerId });
    }
  }
  return out;
}
