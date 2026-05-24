/**
 * lib/db/repositories/roles.ts
 *
 * Roles + role assignments. Read-heavy in the auth path (every request
 * builds an ability from the user's assignments); writes happen only via
 * admin actions.
 */

import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { roleAssignments, type NewRoleAssignment, type RoleAssignment } from "@/lib/db/schema";
import { roles, type NewRole, type Role } from "@/lib/db/schema";
import { countStar } from "@/lib/db/sql-dialect";

/** Find a role by its slug — used by seed and assignment paths. */
export async function findRoleBySlug(slug: string): Promise<Role | null> {
  const rows = await db.select().from(roles).where(eq(roles.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/** Upsert a role by slug. Used by the seed script for system roles. */
export async function upsertRole(input: NewRole): Promise<Role> {
  const rows = await db
    .insert(roles)
    .values(input)
    .onConflictDoUpdate({
      target: roles.slug,
      set: {
        name: input.name,
        description: input.description,
        permissions: input.permissions,
        isSystem: input.isSystem,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!rows[0]) throw new Error("Role upsert returned no row.");
  return rows[0];
}

/** List every role (for the role-management admin page). */
export async function listRoles(): Promise<Role[]> {
  return db.select().from(roles);
}

/**
 * Load a user's role assignments along with each role's permissions and
 * the assignment's scope. This is what the ability builder consumes.
 */
export async function loadUserAssignmentsForAbility(userId: string): Promise<
  Array<{
    permissions: Role["permissions"];
    scopeType: RoleAssignment["scopeType"];
    scopeId: string | null;
  }>
> {
  return db
    .select({
      permissions: roles.permissions,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(eq(roleAssignments.userId, userId));
}

/** Create a role assignment. */
export async function createRoleAssignment(
  input: NewRoleAssignment,
  executor: DbExecutor = db,
): Promise<RoleAssignment> {
  const rows = await executor.insert(roleAssignments).values(input).returning();
  if (!rows[0]) throw new Error("Role assignment insert returned no row.");
  return rows[0];
}

/**
 * Delete a role assignment, scoped to the owning user. Returns true when a
 * row was deleted. The `userId` predicate prevents an IDOR where an actor
 * deletes another user's assignment by passing a mismatched path id.
 */
export async function deleteRoleAssignment(
  id: string,
  userId: string,
  executor: DbExecutor = db,
): Promise<boolean> {
  const rows = await executor
    .delete(roleAssignments)
    .where(and(eq(roleAssignments.id, id), eq(roleAssignments.userId, userId)))
    .returning({ id: roleAssignments.id });
  return rows.length > 0;
}

/**
 * One assignment's role slug + scope, scoped to its owning user (IDOR-safe like
 * `deleteRoleAssignment`). Lets the delete route decide whether removing it
 * would strip the last global Super Admin before it commits.
 */
export async function findAssignmentWithRole(
  assignmentId: string,
  userId: string,
  executor: DbExecutor = db,
): Promise<{ roleSlug: string; scopeType: RoleAssignment["scopeType"] } | null> {
  const rows = await executor
    .select({ roleSlug: roles.slug, scopeType: roleAssignments.scopeType })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(and(eq(roleAssignments.id, assignmentId), eq(roleAssignments.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Count global-scope assignments of the role with `slug` (last-SuperAdmin guard). */
export async function countGlobalAssignmentsOfRoleSlug(
  slug: string,
  executor: DbExecutor = db,
): Promise<number> {
  const rows = await executor
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(and(eq(roles.slug, slug), eq(roleAssignments.scopeType, "global")));
  return rows.length;
}

/**
 * List the distinct role slugs assigned to a user — what the dashboard's
 * "Your roles" summary needs. Deduplicates across scopes.
 */
export async function listRoleSlugsForUser(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: roles.slug })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(eq(roleAssignments.userId, userId));
  return Array.from(new Set(rows.map((row) => row.slug)));
}

/**
 * Distinct role identities the user holds, joined with their MFA-policy
 * flag. Feeds `checkMfaCompliance` from
 * `lib/auth/mfa-compliance.ts` — the layout calls this on every
 * request to decide whether to shunt the operator to forced
 * enrollment.
 *
 * Deduplicates by slug; if the user holds the same role at multiple
 * scopes, the flag is identical, so dedup-by-slug doesn't lose info.
 */
export async function listRoleMfaStatesForUser(
  userId: string,
): Promise<Array<{ slug: string; requiresMfa: boolean }>> {
  const rows = await db
    .select({ slug: roles.slug, requiresMfa: roles.requiresMfa })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(eq(roleAssignments.userId, userId));
  const seen = new Map<string, boolean>();
  for (const r of rows) seen.set(r.slug, r.requiresMfa);
  return Array.from(seen, ([slug, requiresMfa]) => ({ slug, requiresMfa }));
}

/**
 * Full role-assignment rows for a user, joined with role identity. Used by
 * the admin user-detail page to render and manage the assignment list.
 */
export async function listAssignmentsForUserWithRole(userId: string): Promise<
  Array<{
    assignmentId: string;
    roleId: string;
    roleSlug: string;
    roleName: string;
    isSystem: boolean;
    scopeType: RoleAssignment["scopeType"];
    scopeId: string | null;
    createdAt: Date;
  }>
> {
  return db
    .select({
      assignmentId: roleAssignments.id,
      roleId: roles.id,
      roleSlug: roles.slug,
      roleName: roles.name,
      isSystem: roles.isSystem,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
      createdAt: roleAssignments.createdAt,
    })
    .from(roleAssignments)
    .innerJoin(roles, eq(roleAssignments.roleId, roles.id))
    .where(eq(roleAssignments.userId, userId));
}

/** Find a role by id (used for assignment forms and validation). */
export async function findRoleById(id: string): Promise<Role | null> {
  const rows = await db.select().from(roles).where(eq(roles.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Flip the `requiresMfa` flag on a role. Kept as a narrow setter — the
 * rest of a role (slug, name, permissions, isSystem) is either
 * read-only after creation or managed via different code paths. The
 * MFA policy is the only operator-facing setting today, and isolating
 * it lets us audit `role.update` with a minimal field-set diff.
 *
 * Returns the row after the update so the caller can build the audit
 * `before`/`after` snapshots.
 */
export async function setRoleRequiresMfa(id: string, requiresMfa: boolean): Promise<Role | null> {
  const rows = await db
    .update(roles)
    .set({ requiresMfa, updatedAt: new Date() })
    .where(eq(roles.id, id))
    .returning();
  return rows[0] ?? null;
}

/**
 * Count assignments per user — used to enrich the admin users list with a
 * "role count" column without a row-by-row N+1.
 */
export async function countAssignmentsForUsers(userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({
      userId: roleAssignments.userId,
      count: countStar(),
    })
    .from(roleAssignments)
    .where(inArray(roleAssignments.userId, userIds))
    .groupBy(roleAssignments.userId);
  return new Map(rows.map((row) => [row.userId, row.count]));
}

/**
 * Plain create — used by the admin "new role" form. Always inserts as a
 * custom role (`is_system = false`); the seed script owns system roles
 * via `upsertRole`.
 */
export async function insertRole(input: NewRole, executor: DbExecutor = db): Promise<Role> {
  const rows = await executor
    .insert(roles)
    .values({ ...input, isSystem: false })
    .returning();
  if (!rows[0]) throw new Error("Role insert returned no row.");
  return rows[0];
}

/**
 * Patch the editable attributes of a custom role. Slug is intentionally NOT
 * updatable — it's the lookup key in `oidc_providers.group_mappings` and in
 * external IaC files, so renaming would break those silently. Callers that
 * want a different slug should create a new role and migrate assignments.
 *
 * Returns the updated row or null when the id doesn't match anything. The
 * route layer enforces the "no editing system roles" + permission guard.
 */
export async function updateRoleAttrs(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    requiresMfa?: boolean;
    permissions?: string[];
  },
  executor: DbExecutor = db,
): Promise<Role | null> {
  const set: Partial<typeof roles.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.requiresMfa !== undefined) set.requiresMfa = patch.requiresMfa;
  if (patch.permissions !== undefined) set.permissions = patch.permissions;
  const rows = await executor.update(roles).set(set).where(eq(roles.id, id)).returning();
  return rows[0] ?? null;
}

/**
 * Hard-delete a role. Refuses when the row is a system role. The FK on
 * `role_assignments.role_id` is `RESTRICT`, so the DB itself blocks deletes
 * of roles still in use — callers should pre-check via
 * `countAssignmentsForRole` and surface a friendlier error.
 */
export async function deleteRole(
  id: string,
  executor: DbExecutor = db,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const existing = await findRoleById(id);
  if (!existing) return { ok: false, reason: "not-found" };
  if (existing.isSystem) return { ok: false, reason: "system-role" };
  await executor.delete(roles).where(eq(roles.id, id));
  return { ok: true };
}

/** Count `role_assignments` rows pointing at this role. */
export async function countAssignmentsForRole(roleId: string): Promise<number> {
  const rows = await db
    .select({ count: countStar() })
    .from(roleAssignments)
    .where(eq(roleAssignments.roleId, roleId));
  return Number(rows[0]?.count ?? 0);
}
