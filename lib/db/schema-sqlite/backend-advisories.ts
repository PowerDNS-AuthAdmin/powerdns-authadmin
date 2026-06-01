/**
 * lib/db/schema-sqlite/backend-advisories.ts - SQLite mirror of
 * `../schema/backend-advisories.ts`.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pdnsServers } from "./pdns-servers";
import { pk } from "./_helpers";

export const backendAdvisories = sqliteTable(
  "backend_advisories",
  {
    id: pk(),
    backendId: text("backend_id")
      .notNull()
      .references(() => pdnsServers.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    acknowledgedAt: integer("acknowledged_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    backendCodeIdx: uniqueIndex("backend_advisories_backend_code_idx").on(t.backendId, t.code),
    backendIdx: index("backend_advisories_backend_idx").on(t.backendId),
  }),
);

export type BackendAdvisory = typeof backendAdvisories.$inferSelect;
export type NewBackendAdvisory = typeof backendAdvisories.$inferInsert;
