/**
 * lib/db/schema/role-assignments.ts
 *
 * The (user × role × scope) join. A user gains a role's permissions only
 * within the scope of the assignment. for the model.
 *
 * Scope nesting:
 *   global              ⊇  team:<id>   ⊇  zone:<id>
 *                       ⊇  server:<id> ⊇  zone:<id>
 *
 * `scope_id` is nullable: when `scope_type = "global"`, no specific resource
 * is referenced. For other scopes, it's the UUID of the team / zone / server.
 * We don't declare a foreign key on `scope_id` because the target table
 * varies; instead we validate at the application layer.
 */

import { index, pgEnum, pgTable, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { roles } from "./roles";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const scopeTypeEnum = pgEnum("scope_type", ["global", "team", "zone", "server"]);

export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: pk(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),

    scopeType: scopeTypeEnum("scope_type").notNull(),
    scopeId: uuid("scope_id"),

    // The user who created this assignment, for audit / revocation. NULL when
    // the assignment was created by the seed script or system boot.
    //
    // After #85: role_assignments holds admin-issued rows only. IdP-derived
    // permissions live on `sessions.derived_permissions`. The previous
    // `provider_id` column was dropped in the same migration that introduced
    // session-scoped derivation.
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    userIdx: index("role_assignments_user_idx").on(t.userId),
    roleIdx: index("role_assignments_role_idx").on(t.roleId),
    scopeIdx: index("role_assignments_scope_idx").on(t.scopeType, t.scopeId),

    // A user has each role at most once per scope. Catches the "I assigned the
    // same role twice" footgun without losing the ability to assign the same
    // role at different scopes.
    uniq: uniqueIndex("role_assignments_unique_idx").on(t.userId, t.roleId, t.scopeType, t.scopeId),
  }),
);

export type RoleAssignment = typeof roleAssignments.$inferSelect;
export type NewRoleAssignment = typeof roleAssignments.$inferInsert;
