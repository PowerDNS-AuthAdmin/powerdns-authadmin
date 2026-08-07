/**
 * lib/db/schema/zone-horizons.ts
 *
 * Per-zone HORIZON classification - "this copy of the zone is the internal
 * one." Split-horizon DNS serves the same name differently to the internet and
 * to the internal network, usually from two separate daemons, and PowerDNS has
 * nothing to distinguish the two: both are just a zone called `example.com.`
 * on some backend. This table is where the operator says which is which
 * (ADR-0022, #121).
 *
 * Shape notes:
 *
 *   - **Sparse by design.** Only a deviation from the default horizon is
 *     stored; a zone with no row here is `public`. That means no backfill for
 *     existing installs, and clearing the flag deletes the row rather than
 *     writing `public` back. The `horizon` column still carries the value so a
 *     third horizon can be added without a migration.
 *
 *   - **Scoped to a backend, not to a name.** `zone_name` alone would be
 *     wrong - the whole point is that two backends host the same name. Exactly
 *     one of `server_id` / `cluster_id` is set, enforced by a CHECK.
 *
 *   - **Why `cluster_id` at all**, when `zone_grants` keys everything on
 *     `server_id`: a cluster zone's reads and writes resolve a peer per request
 *     via `choosePeer`, so a flag stored against one peer would appear and
 *     disappear as the strategy rotated. Grants solve that by expanding across
 *     peers on the authz path; a classification has no principal to expand for,
 *     so it is simply stored against the cluster it belongs to.
 *
 *   - `zone_name` is canonical (lowercase, trailing dot), canonicalized by the
 *     writing route. Not a foreign key - PDNS owns zone identity, so a row can
 *     outlive a deleted zone. That's harmless: an orphaned classification
 *     applies to nothing.
 */

import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { type ZoneHorizon } from "@/lib/dns/zone-horizon";
import { pdnsClusters } from "./pdns-clusters";
import { pdnsServers } from "./pdns-servers";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const zoneHorizons = pgTable(
  "zone_horizons",
  {
    id: pk(),

    /**
     * Standalone server / primary the zone lives on. NULL for a cluster zone.
     * Cascade-deleted with the backend - a classification of a zone on a
     * backend we no longer manage is meaningless.
     */
    serverId: uuid("server_id").references(() => pdnsServers.id, { onDelete: "cascade" }),

    /** Cluster the zone lives on. NULL for a standalone-server zone. */
    clusterId: uuid("cluster_id").references(() => pdnsClusters.id, { onDelete: "cascade" }),

    /** Canonical zone name (lowercase, trailing dot). */
    zoneName: text("zone_name").notNull(),

    /** Vocabulary in `lib/dns/zone-horizon.ts`; CHECK-constrained below. */
    horizon: text("horizon").$type<ZoneHorizon>().notNull(),

    /** Who classified it. NULL once that user is deleted - the classification
     *  itself outlives them (removing it is a deliberate act). */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),

    ...timestamps(),
  },
  (t) => ({
    // At most one classification per (backend, zone). Partial uniques, because
    // a composite unique over a nullable column doesn't constrain the rows we
    // care about - same footgun `zone_grants` documents for its principals.
    serverUniq: uniqueIndex("zone_horizons_server_unique_idx")
      .on(t.serverId, t.zoneName)
      .where(sql`${t.serverId} IS NOT NULL`),
    clusterUniq: uniqueIndex("zone_horizons_cluster_unique_idx")
      .on(t.clusterId, t.zoneName)
      .where(sql`${t.clusterId} IS NOT NULL`),
    // The zones list loads every classification at once and indexes it in
    // memory; this supports the per-zone lookups the detail page does.
    zoneIdx: index("zone_horizons_zone_idx").on(t.zoneName),
    scopeCheck: check(
      "zone_horizons_scope_check",
      sql`(${t.serverId} IS NULL) <> (${t.clusterId} IS NULL)`,
    ),
    horizonCheck: check("zone_horizons_horizon_check", sql`${t.horizon} IN ('public', 'internal')`),
  }),
);

export type ZoneHorizonRow = typeof zoneHorizons.$inferSelect;
export type NewZoneHorizonRow = typeof zoneHorizons.$inferInsert;
