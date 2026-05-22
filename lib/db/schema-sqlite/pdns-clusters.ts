/**
 * lib/db/schema-sqlite/pdns-clusters.ts — SQLite mirror of
 * `../schema/pdns-clusters.ts`. See that file for the design + semantics.
 */

import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const pdnsClusters = sqliteTable(
  "pdns_clusters",
  {
    id: pk(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    writeStrategy: text("write_strategy").notNull().default("round_robin"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    writeStrategyCheck: check(
      "pdns_clusters_write_strategy_check",
      sql`${t.writeStrategy} IN ('round_robin','lowest_latency','random','least_load')`,
    ),
  }),
);

export type PdnsCluster = typeof pdnsClusters.$inferSelect;
export type NewPdnsCluster = typeof pdnsClusters.$inferInsert;
