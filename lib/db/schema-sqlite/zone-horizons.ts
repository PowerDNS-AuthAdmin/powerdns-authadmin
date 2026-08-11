/**
 * lib/db/schema-sqlite/zone-horizons.ts - SQLite mirror of
 * `../schema/zone-horizons.ts`.
 *
 * See the PG schema for the design rationale (sparse storage, server-or-cluster
 * scope, partial unique indexes, zone-name canonicalization).
 */

import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { type ZoneHorizon } from "@/lib/dns/zone-horizon";
import { pdnsClusters } from "./pdns-clusters";
import { pdnsServers } from "./pdns-servers";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const zoneHorizons = sqliteTable(
  "zone_horizons",
  {
    id: pk(),
    serverId: text("server_id").references(() => pdnsServers.id, { onDelete: "cascade" }),
    clusterId: text("cluster_id").references(() => pdnsClusters.id, { onDelete: "cascade" }),
    zoneName: text("zone_name").notNull(),
    horizon: text("horizon").$type<ZoneHorizon>().notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    serverUniq: uniqueIndex("zone_horizons_server_unique_idx")
      .on(t.serverId, t.zoneName)
      .where(sql`${t.serverId} IS NOT NULL`),
    clusterUniq: uniqueIndex("zone_horizons_cluster_unique_idx")
      .on(t.clusterId, t.zoneName)
      .where(sql`${t.clusterId} IS NOT NULL`),
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
