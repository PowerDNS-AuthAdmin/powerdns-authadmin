/**
 * lib/db/schema-sqlite/pdns-requests.ts — SQLite mirror of `../schema/pdns-requests.ts`.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { pdnsServers } from "./pdns-servers";

export const pdnsRequests = sqliteTable(
  "pdns_requests",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    ts: integer("ts", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    requestId: text("request_id"),
    serverId: text("server_id").references(() => pdnsServers.id, { onDelete: "set null" }),
    serverSlug: text("server_slug"),
    op: text("op").notNull(),
    method: text("method").notNull(),
    url: text("url").notNull(),
    requestHeaders: text("request_headers", { mode: "json" }).$type<Record<string, string>>(),
    requestBody: text("request_body", { mode: "json" }),
    responseStatus: integer("response_status"),
    error: text("error"),
  },
  (t) => ({
    requestIdIdx: index("pdns_requests_request_id_idx").on(t.requestId),
    tsIdx: index("pdns_requests_ts_idx").on(t.ts),
    serverIdIdx: index("pdns_requests_server_id_idx").on(t.serverId),
  }),
);

export type PdnsRequestRow = typeof pdnsRequests.$inferSelect;
export type NewPdnsRequestRow = typeof pdnsRequests.$inferInsert;
