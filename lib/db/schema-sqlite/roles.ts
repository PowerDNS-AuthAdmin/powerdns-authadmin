/**
 * lib/db/schema-sqlite/roles.ts — SQLite mirror of `../schema/roles.ts`.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { pk, timestamps } from "./_helpers";

type StoredPermission = string;

export const roles = sqliteTable(
  "roles",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    isSystem: integer("is_system", { mode: "boolean" }).notNull().default(false),
    requiresMfa: integer("requires_mfa", { mode: "boolean" }).notNull().default(false),

    permissions: text("permissions", { mode: "json" })
      .$type<StoredPermission[]>()
      .notNull()
      .default([]),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("roles_slug_idx").on(t.slug),
    systemIdx: index("roles_system_idx").on(t.isSystem),
  }),
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
