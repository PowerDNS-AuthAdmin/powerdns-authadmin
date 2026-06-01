/**
 * lib/db/schema-sqlite/role-assignments.ts - SQLite mirror of `../schema/role-assignments.ts`.
 */

import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { roles } from "./roles";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const roleAssignments = sqliteTable(
  "role_assignments",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: text("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),

    scopeType: text("scope_type").notNull(),
    scopeId: text("scope_id"),

    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("role_assignments_user_idx").on(t.userId),
    roleIdx: index("role_assignments_role_idx").on(t.roleId),
    scopeIdx: index("role_assignments_scope_idx").on(t.scopeType, t.scopeId),
    uniq: uniqueIndex("role_assignments_unique_idx").on(t.userId, t.roleId, t.scopeType, t.scopeId),
    scopeTypeCheck: check(
      "role_assignments_scope_type_check",
      sql`${t.scopeType} IN ('global','team','zone','server')`,
    ),
  }),
);

export type RoleAssignment = typeof roleAssignments.$inferSelect;
export type NewRoleAssignment = typeof roleAssignments.$inferInsert;
