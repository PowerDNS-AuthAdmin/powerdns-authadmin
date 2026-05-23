/**
 * lib/db/schema-sqlite/pdns-servers.ts — SQLite mirror of `../schema/pdns-servers.ts`.
 */

import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { PdnsVersionCache } from "@/lib/pdns/types";
import { pdnsClusters } from "./pdns-clusters";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export type { PdnsVersionCache } from "@/lib/pdns/types";

export const pdnsServers = sqliteTable(
  "pdns_servers",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    baseUrl: text("base_url").notNull(),
    serverId: text("server_id").notNull().default("localhost"),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    versionCache: text("version_cache", { mode: "json" }).$type<PdnsVersionCache | null>(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    role: text("role").notNull().default("primary"),
    primaryId: text("primary_id").references((): AnySQLiteColumn => pdnsServers.id, {
      onDelete: "cascade",
    }),
    clusterId: text("cluster_id").references(() => pdnsClusters.id, { onDelete: "set null" }),
    disabledAt: integer("disabled_at", { mode: "timestamp_ms" }),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("pdns_servers_slug_idx").on(t.slug),
    defaultIdx: index("pdns_servers_default_idx").on(t.isDefault),
    disabledIdx: index("pdns_servers_disabled_idx").on(t.disabledAt),
    roleIdx: index("pdns_servers_role_idx").on(t.role),
    primaryIdx: index("pdns_servers_primary_id_idx").on(t.primaryId),
    clusterIdx: index("pdns_servers_cluster_id_idx").on(t.clusterId),
    roleCheck: check("pdns_servers_role_check", sql`${t.role} IN ('primary','secondary')`),
  }),
);

export type PdnsServer = typeof pdnsServers.$inferSelect;
export type NewPdnsServer = typeof pdnsServers.$inferInsert;
