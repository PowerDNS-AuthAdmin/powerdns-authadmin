/**
 * lib/db/schema-sqlite/settings.ts - SQLite mirror of `../schema/settings.ts`.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { users } from "./users";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
