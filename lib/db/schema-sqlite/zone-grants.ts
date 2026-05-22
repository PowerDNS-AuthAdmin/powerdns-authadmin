/**
 * lib/db/schema-sqlite/zone-grants.ts — SQLite mirror of `../schema/zone-grants.ts`.
 */

import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pdnsServers } from "./pdns-servers";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

type StoredPermission = string;

export const zoneGrants = sqliteTable(
  "zone_grants",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    serverId: text("server_id")
      .notNull()
      .references(() => pdnsServers.id, { onDelete: "cascade" }),
    zoneName: text("zone_name").notNull(),
    permissions: text("permissions", { mode: "json" })
      .$type<StoredPermission[]>()
      .notNull()
      .default([]),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    userIdx: index("zone_grants_user_idx").on(t.userId),
    zoneIdx: index("zone_grants_zone_idx").on(t.serverId, t.zoneName),
    uniq: uniqueIndex("zone_grants_unique_idx").on(t.userId, t.serverId, t.zoneName),
  }),
);

export type ZoneGrant = typeof zoneGrants.$inferSelect;
export type NewZoneGrant = typeof zoneGrants.$inferInsert;
