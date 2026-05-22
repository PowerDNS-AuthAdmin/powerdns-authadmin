/**
 * lib/db/schema/zone-grants.ts
 *
 * Explicit per-zone permission grants. The bridge between PDNS (which
 * owns zone identity) and our RBAC layer (which owns who-can-do-what):
 * a `zone_grants` row says "this user, on this backend, has this
 * permission set for this specific zone."
 *
 * Why a separate table from `role_assignments`:
 *   - `role_assignments` carries a `scope_id` that's a UUID into one
 *     of our local tables (`teams`, `pdns_servers`). Zones don't live
 *     in our DB — PDNS owns them. Using `scope_id` for a zone name
 *     would require either a parallel local `zones` table (cost: every
 *     PDNS write needs a mirror write here, with reconciliation when
 *     PDNS drops a zone) or stuffing a non-UUID string into a UUID
 *     column (cost: typing lie, scope lookups break).
 *   - Per-zone grants want a direct permission set without going
 *     through the role indirection. `role_assignments` assigns *a
 *     role's* permissions; this table assigns *a literal permission
 *     list* the operator chose at grant time. Closer to a fixed-list
 *     legacy DomainUser shape that operators expect.
 *
 * Effective permissions for a (user, server, zone) are the UNION of:
 *   - role_assignments at global / team / server scopes (existing path)
 *   - zone_grants rows matching (user, server, zone)
 *wiring (next tick) extends `buildAbility` to fold these in.
 *
 * `zone_name` is canonical: lowercase, trailing dot. The grant route
 * canonicalizes before write — readers should not re-canonicalize.
 */

import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pdnsServers } from "./pdns-servers";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

// Same rationale as `lib/db/schema/api-tokens.ts` (and `roles.ts`):
// the column stores values from the master permission vocabulary in
// `lib/rbac/permissions.ts`, but we don't import the `Permission`
// type here — the `lib/db → lib/rbac` direction is forbidden by the
// architecture. Validation that the strings match the vocabulary
// happens at the route layer above the DB.
type StoredPermission = string;

export const zoneGrants = pgTable(
  "zone_grants",
  {
    id: pk(),

    /** Operator the grant applies to. Cascade-deleted with the user. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

    /**
     * PDNS backend the zone lives on. Cascade-deleted with the backend
     * row — grants are meaningless when the server is gone.
     */
    serverId: uuid("server_id")
      .notNull()
      .references(() => pdnsServers.id, { onDelete: "cascade" }),

    /**
     * Canonical zone name (lowercase, trailing dot). NOT a foreign key
     * — PDNS owns zone identity; if the operator deletes the zone on
     * PDNS the grant lingers harmlessly until cleaned up by the admin
     * UI. The orphan grant is no security risk (the zone doesn't exist
     * to act on).
     */
    zoneName: text("zone_name").notNull(),

    /**
     * Subset of the master permission vocabulary
     * (`lib/rbac/permissions.ts`). Empty array means "no
     * permissions" — the row exists but grants nothing, useful as a
     * placeholder while an operator builds up a grant.
     */
    permissions: jsonb("permissions").$type<StoredPermission[]>().notNull().default([]),

    /**
     * Who issued the grant. NULL when the granting user was later
     * deleted (we keep the grant; revoke is an explicit admin
     * action).
     */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("zone_grants_user_idx").on(t.userId),
    // Reverse-lookup: "who has access to (server, zone)?" — used by
    // the per-zone audit / settings UI.
    zoneIdx: index("zone_grants_zone_idx").on(t.serverId, t.zoneName),
    // A user has at most one grant per (server, zone). Re-granting
    // is an explicit update, not a duplicate.
    uniq: uniqueIndex("zone_grants_unique_idx").on(t.userId, t.serverId, t.zoneName),
  }),
);

export type ZoneGrant = typeof zoneGrants.$inferSelect;
export type NewZoneGrant = typeof zoneGrants.$inferInsert;
