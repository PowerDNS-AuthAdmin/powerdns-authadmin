/**
 * lib/db/schema/roles.ts
 *
 * The roles table. Roles are named bundles of permissions. A user has a role
 * via `role_assignments`, which carries a *scope* (global / team / zone /
 * server) — the same role can grant different access at different scopes.
 *
 * `is_system = true` marks the seeded built-in roles (SuperAdmin, TeamOwner,
 * Operator, ZoneEditor, ReadOnly). System roles can't be deleted and their
 * permissions can't be edited (only viewed) in the admin UI; this prevents an
 * operator from accidentally locking themselves out by stripping SuperAdmin.
 *
 * `permissions` is the source of truth — a flat list of permission strings
 * (e.g. "zone.read", "record.update") that this role grants. The strings
 * match the vocabulary in `lib/rbac/permissions.ts`; validation happens at
 * the API boundary (you can't write `permissions: ["foo.bar"]`).
 */

import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_helpers";

// The `permissions` column stores values from the master permission
// vocabulary defined in `lib/rbac/permissions.ts` (the `Permission`
// type). We deliberately don't import that type here: the
// `lib/db → lib/rbac` direction is forbidden by the architecture
// (RBAC sits above the DB). The runtime check that values are valid
// permissions happens at the CASL ability-build layer; the DB column
// is structurally a string array.
type StoredPermission = string;

export const roles = pgTable(
  "roles",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),

    isSystem: boolean("is_system").notNull().default(false),

    // Operators with at least one role marked `requiresMfa` must
    // have TOTP enrolled (or another MFA method, when more land).
    // Enforcement lives in the require-user gate and at session-
    // start; when an MFA-required user lacks TOTP they're shunted
    // to a forced-enrollment flow. Default false so existing roles
    // don't suddenly require MFA on migration.
    requiresMfa: boolean("requires_mfa").notNull().default(false),

    // Stored as a flat string array. Validated against `Permission` in
    // lib/rbac/permissions.ts at the application layer.
    permissions: jsonb("permissions").$type<StoredPermission[]>().notNull().default([]),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("roles_slug_idx").on(t.slug),
    systemIdx: index("roles_system_idx").on(t.isSystem),
  }),
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
