/**
 * lib/rbac/zone-permissions.ts
 *
 * The single source of truth for "may this user do X on this zone?". Every
 * zone-bound decision - the zones list, the zone page and its tabs, record /
 * settings / DNSSEC / metadata writes, zone export, the realtime
 * stream, MCP and DynDNS - goes through `canActOnZone` (or `canListZones` /
 * `listableZoneFilter` for the list views) here, so the three sources of
 * zone access can't drift apart between surfaces.
 *
 * Pure - the storage shape of a grant (`{serverId, zoneName, permissions}`)
 * is declared inline so this module doesn't take a dependency on the DB
 * layer (which would block unit tests under the vitest worker that can't
 * load `pg`).
 *
 * Effective permission for a (user, server, zone, action) is the union of:
 *   1. a role assignment at GLOBAL scope that grants the action
 *      (`globalPermissions`);
 *   2. a `zone_grants` row for this exact (server, zone) whose
 *      `permissions` list contains the action;
 *   3. a role assignment scoped to `zone:<name>` - admin-issued
 *      `role_assignments` or IdP-derived `sessions.derived_permissions` -
 *      whose role carries the action (ADR-0024).
 *
 * Why zone-scoped roles are folded in here instead of via the CASL ability:
 * zones have no local row (they live in PowerDNS), so there is no zone
 * instance to evaluate a CASL condition against. Until ADR-0024 that meant
 * role-based zone access was all-or-nothing (GLOBAL only) and a zone-scoped
 * assignment was silently inert. We now resolve it by name here.
 *
 * A zone scope names a zone, not a backend: `zone:example.com.` matches a
 * zone called `example.com.` on EVERY backend (compared after
 * `canonicalZoneName`). A `zone_grants` row stays pinned to one server.
 *
 * Containment (ADR-0024 threat model): a zone-scoped role contributes only
 * zone-bound permissions (`zone.*` except `zone.create`, `record.*`, `soa.*`,
 * `dnssec.*`, `metadata.*`); it never reaches `globalPermissions`, so it
 * can't satisfy a global gate (zone creation, users, roles, servers,
 * settings, audit, TSIG) and only ever answers for the zone it names.
 */

import { canonicalZoneName } from "@/lib/dns/zone-name";

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
 * Whether a permission can be carried by a `zone:<name>` role scope. Only
 * actions that target one existing zone qualify. `zone.create` is excluded
 * because a zone that doesn't exist yet can't be inside a zone scope, and
 * `tsig.*` because TSIG keys are server-wide objects shared by many zones.
 */
export function isZoneScopablePermission(permission: string): boolean {
  if (permission === "zone.create") return false;
  return /^(zone|record|soa|dnssec|metadata)\./.test(permission);
}

/** One role assignment as the ability builder sees it (admin- or IdP-issued). */
export interface ScopedPermissionSource {
  scopeType: string;
  scopeId: string | null;
  permissions: readonly string[];
}

/**
 * Collapse the zone-scoped entries of a user's assignment list into
 * canonical zone name → permissions. Non-zone scopes and non-zone-bound
 * permissions are dropped here, which is what keeps a zone-scoped role from
 * leaking into any other decision.
 *
 * Scope ids are canonicalised because an IdP mapping stores whatever the
 * operator typed (`Example.COM` vs `example.com.`), and PowerDNS always
 * reports the canonical form.
 */
export function zoneScopedPermissionsOf(
  sources: readonly ScopedPermissionSource[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const out = new Map<string, Set<string>>();
  for (const src of sources) {
    if (src.scopeType !== "zone" || src.scopeId === null) continue;
    const zone = canonicalZoneName(src.scopeId);
    if (zone === "") continue;
    for (const p of src.permissions) {
      if (!isZoneScopablePermission(p)) continue;
      let set = out.get(zone);
      if (!set) {
        set = new Set();
        out.set(zone, set);
      }
      set.add(p);
    }
  }
  return out;
}

/**
 * Everything `canActOnZone` needs about the caller. `AuthenticatedRequest`
 * (lib/auth/get-current-user) satisfies it structurally, so route handlers
 * pass the `requireUser()` result straight through.
 *
 * `globalPermissions` must be the *global*-scope set (`globalPermissionsOf`),
 * NOT a type-level `ability.can(action, "Type")` - the latter is true for
 * any conditionally-scoped rule and would let a team/zone-scoped role act on
 * every zone.
 */
export interface ZoneAccess {
  globalPermissions: ReadonlySet<string>;
  zoneGrants: readonly ZoneGrantInput[];
  zoneScopedPermissions: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * The one per-zone authorization check: allowed when the permission is held
 * globally, OR a `zone_grant` for THIS (server, zone) includes it, OR a role
 * scoped to this zone name carries it.
 *
 * @example
 *   const auth = await requireUser();
 *   if (!canActOnZone(auth, { serverId: server.id, zoneName, permission: "metadata.write" })) {
 *     throw new ForbiddenError("Missing metadata.write for this zone.");
 *   }
 */
export function canActOnZone(
  access: ZoneAccess,
  target: { serverId: string; zoneName: string; permission: string },
): boolean {
  if (access.globalPermissions.has(target.permission)) return true;
  if (
    hasZonePermissionViaGrant(
      access.zoneGrants,
      target.serverId,
      target.zoneName,
      target.permission,
    )
  ) {
    return true;
  }
  return hasZoneScopedPermission(access, target.zoneName, target.permission);
}

/**
 * The zone-scoped-role leg of `canActOnZone` on its own, for callers that
 * only know a zone NAME (the realtime stream filters events by name). Any
 * backend: a zone scope carries no server.
 */
export function hasZoneScopedPermission(
  access: Pick<ZoneAccess, "zoneScopedPermissions">,
  zoneName: string,
  permission: string,
): boolean {
  // `zone.create` and friends are filtered out at collection time too;
  // checked again so the guarantee doesn't depend on how the map was built.
  if (!isZoneScopablePermission(permission)) return false;
  return access.zoneScopedPermissions.get(canonicalZoneName(zoneName))?.has(permission) ?? false;
}

/**
 * Which zones a list view may show. `all` for a global `zone.read`;
 * otherwise the canonical names of every zone the user holds a `zone_grant`
 * on (any permission - the list has always shown granted zones) plus every
 * zone a zone-scoped role gives `zone.read` on (a scoped role without
 * `zone.read` would only lead to a zone page that refuses it).
 *
 * Name-only, like the zone scope itself: the detail page and the API still
 * decide per (server, zone) through `canActOnZone`.
 */
export type ZoneListFilter = { all: true } | { all: false; names: ReadonlySet<string> };

export function listableZoneFilter(access: ZoneAccess): ZoneListFilter {
  if (access.globalPermissions.has("zone.read")) return { all: true };
  const names = new Set<string>();
  for (const g of access.zoneGrants) names.add(canonicalZoneName(g.zoneName));
  for (const zone of access.zoneScopedPermissions.keys()) {
    if (hasZoneScopedPermission(access, zone, "zone.read")) names.add(zone);
  }
  return { all: false, names };
}

/** Whether a zone row passes a `listableZoneFilter` result. */
export function zoneIsListable(filter: ZoneListFilter, zoneName: string): boolean {
  return filter.all || filter.names.has(canonicalZoneName(zoneName));
}

/**
 * Whether the zones list admits the user at all - the shared predicate for
 * the /zones page guard and its nav entry, so the menu never offers a page
 * that would refuse.
 */
export function canListZones(access: ZoneAccess): boolean {
  const filter = listableZoneFilter(access);
  return filter.all || filter.names.size > 0;
}

/**
 * Whether the user holds a permission matching `matches` on at least one
 * specific zone through a grant or a zone-scoped role (global grants are the
 * caller's own check). Used to decide whether a capability is worth offering
 * at all, e.g. the MCP write tools.
 */
export function holdsOnSomeZone(
  access: ZoneAccess,
  matches: (permission: string) => boolean,
): boolean {
  if (access.zoneGrants.some((g) => g.permissions.some(matches))) return true;
  for (const perms of access.zoneScopedPermissions.values()) {
    for (const p of perms) if (matches(p)) return true;
  }
  return false;
}

/**
 * Whether the Add record wizard (/zones/new-record) admits the user: a global
 * `record.create`, or `record.create` on at least one zone through a grant or
 * a zone-scoped role. The wizard's zone search then offers only the zones
 * where `canActOnZone` allows the write. Shared by the page guard, its nav
 * entry, the Zones toolbar button and the search palette shortcut, so none of
 * them offers a page that refuses.
 */
export function canUseRecordWizard(access: ZoneAccess): boolean {
  return (
    access.globalPermissions.has("record.create") ||
    holdsOnSomeZone(access, (p) => p === "record.create")
  );
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
 * Zone-scoped roles need no expansion: they match by name on every backend.
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
