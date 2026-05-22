/**
 * lib/auth/token-scope-narrowing.ts
 *
 * Pure transformation that takes the user's effective role assignments
 * (the same shape `buildAbility` consumes) and narrows each assignment's
 * permission list to the intersection with a PAT's stored scopes. The
 * narrowed assignments feed `buildAbility` so the resulting CASL ability
 * is the floor of "what the user can do" and "what the token may do".
 *
 * Lives in its own module so it can be unit-tested without dragging in
 * the database or CASL — both are heavy modules whose imports surface
 * environment dependencies (postgres pool, JSX/server-only marker)
 * that the test runner doesn't always have.
 *
 * Key design points:
 *   - **Floor semantics.** The token grants a subset, never a
 *     superset. If the user lost a permission since the token was
 *     issued, the token can't use it anymore.
 *   - **Empty-token-scopes means "all current user permissions".**
 *     The DB column defaults to `[]` for backward compatibility with
 *     tokens issued before scope-narrowing was a feature; that case
 *     should keep behaving as "use everything the user has". An
 *     operator who wants a no-permission token can issue one with a
 *     deliberately-empty assignment instead.
 *   - **Assignments with zero surviving permissions are dropped.**
 *     Keeping them around would be inert anyway (CASL gets no rules
 *     from them) but produce noise in any audit/debug snapshot of the
 *     ability sources.
 */

import type { Permission } from "@/lib/rbac/permissions";

/**
 * Same shape as `AbilitySource` from `lib/rbac/ability.ts`, redeclared
 * here so this module doesn't pull in CASL. The two stay in sync by
 * convention — when `AbilitySource` changes, mirror it here.
 */
export interface NarrowableAssignment {
  permissions: readonly Permission[];
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}

export function narrowAssignmentsByTokenScopes(
  assignments: readonly NarrowableAssignment[],
  // Accepts `readonly string[]` rather than `readonly Permission[]`
  // because the DB-stored scopes column is structurally string[] —
  // `lib/db/schema/*` deliberately doesn't import the typed
  // `Permission` from `lib/rbac/permissions` (cross-layer import
  // forbidden). At runtime this is a pure string-set intersection;
  // permissions that don't match the master vocabulary are simply
  // dropped (the user's assignments only contain valid Permission
  // values, so an unrecognised token-scope entry can't grant
  // anything).
  tokenScopes: readonly string[],
): NarrowableAssignment[] {
  // Empty stored scopes = "use everything the user has" (see header).
  if (tokenScopes.length === 0) {
    return assignments.map((a) => ({ ...a, permissions: [...a.permissions] }));
  }

  const allowed = new Set<string>(tokenScopes);
  const out: NarrowableAssignment[] = [];
  for (const a of assignments) {
    const filtered = a.permissions.filter((p) => allowed.has(p));
    if (filtered.length > 0) {
      out.push({ ...a, permissions: filtered });
    }
  }
  return out;
}
