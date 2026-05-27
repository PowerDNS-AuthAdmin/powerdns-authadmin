/**
 * lib/db/schema-sqlite/zone-grants.ts — SQLite mirror of `../schema/zone-grants.ts`.
 *
 * See the PG schema for the design rationale (principal split, exactly-one
 * principal, partial unique indexes, zone-name canonicalization).
 */

import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pdnsServers } from "./pdns-servers";
import { teams } from "./teams";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

type StoredPermission = string;

export const zoneGrants = sqliteTable(
  "zone_grants",
  {
    id: pk(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
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
    teamIdx: index("zone_grants_team_idx").on(t.teamId),
    zoneIdx: index("zone_grants_zone_idx").on(t.serverId, t.zoneName),
    userUniq: uniqueIndex("zone_grants_user_unique_idx")
      .on(t.userId, t.serverId, t.zoneName)
      .where(sql`${t.userId} IS NOT NULL`),
    teamUniq: uniqueIndex("zone_grants_team_unique_idx")
      .on(t.teamId, t.serverId, t.zoneName)
      .where(sql`${t.teamId} IS NOT NULL`),
    principalCheck: check(
      "zone_grants_principal_check",
      sql`(${t.userId} IS NULL) <> (${t.teamId} IS NULL)`,
    ),
  }),
);

export type ZoneGrant = typeof zoneGrants.$inferSelect;
export type NewZoneGrant = typeof zoneGrants.$inferInsert;
