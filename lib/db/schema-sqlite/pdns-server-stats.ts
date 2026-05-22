/**
 * lib/db/schema-sqlite/pdns-server-stats.ts — SQLite mirror of `../schema/pdns-server-stats.ts`.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pdnsServers } from "./pdns-servers";

export const pdnsServerStats = sqliteTable(
  "pdns_server_stats",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    ts: integer("ts", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    serverId: text("server_id")
      .references(() => pdnsServers.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    value: integer("value", { mode: "number" }),
    mapValue: text("map_value", { mode: "json" }).$type<Array<{ name: string; value: string }>>(),
  },
  (t) => ({
    serverTsIdx: index("pdns_server_stats_server_ts_idx").on(t.serverId, t.ts),
    serverNameTsIdx: index("pdns_server_stats_server_name_ts_idx").on(t.serverId, t.name, t.ts),
    tsIdx: index("pdns_server_stats_ts_idx").on(t.ts),
  }),
);

export type PdnsServerStatRow = typeof pdnsServerStats.$inferSelect;
export type NewPdnsServerStatRow = typeof pdnsServerStats.$inferInsert;
