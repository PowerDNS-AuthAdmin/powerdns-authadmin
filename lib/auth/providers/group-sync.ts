/**
 * lib/auth/providers/group-sync.ts
 *
 * Compute the IdP-group → permission set for a sign-in. Used by every
 * provider type (OIDC, SAML, LDAP) — the input differs (which claim
 * carries the groups) but the resolution is identical. Protocol-
 * agnostic by design.
 *
 * #85 model:
 *   - At sign-in, `computeGroupSync` reads the raw groups input + the
 *     provider's `group_mappings` and returns an array of `AbilitySource`
 *     entries (one per matched mapping).
 *   - The caller hands the array to `startSession`, which persists it
 *     into `sessions.derived_permissions`.
 *   - The ability builder folds the session column into the request's
 *     effective permission set alongside admin-issued `role_assignments`.
 *
 * No DB writes happen here. The previous `applyGroupSync` that mutated
 * `role_assignments` rows is gone — provider-derived permissions don't
 * persist on the user, they live and die with the session (and tokens
 * re-check at use time; see `getCurrentUser`'s token path).
 *
 * Unresolvable mappings (missing role slug, missing team / server)
 * surface as `unresolved` entries on the result so the caller can audit
 * the operator typo without aborting sign-in.
 */

import "server-only";
import { db } from "@/lib/db";
import { roles } from "@/lib/db/schema";
import type { Permission } from "@/lib/rbac/permissions";
import { readGroupClaim, type GroupMapping } from "./group-sync-pure";

export { readGroupClaim } from "./group-sync-pure";
export type {
  GroupMapping,
  /** @deprecated Use `GroupMapping`. */
  OidcGroupMapping,
  ResolvedAssignment,
  GroupSyncDiff,
} from "./group-sync-pure";
// `diffGroupSync` is no longer used at runtime after #85 but stays in the
// pure module for the integration tests + as a building block for any
// future "live session refresh" work.
export { diffGroupSync } from "./group-sync-pure";

/**
 * One entry in `computeGroupSync`'s output. Matches the `AbilitySource`
 * shape (`lib/rbac/ability.ts`) — the permissions list is the role's
 * permissions inlined at compute time. We inline at sign-in so the
 * session snapshot is self-contained: an admin renaming a role doesn't
 * silently change what an active session is allowed to do, and the
 * ability builder doesn't need a runtime role-name lookup against
 * derived rows.
 */
export interface DerivedAbilitySource {
  permissions: readonly Permission[];
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}

export interface UnresolvedGroupMapping {
  group: string;
  roleSlug: string;
  reason: "role-slug-not-found";
}

export interface GroupSyncResult {
  derived: DerivedAbilitySource[];
  unresolved: UnresolvedGroupMapping[];
}

interface ComputeGroupSyncInput {
  /** Raw groups input from the provider. OIDC: claim value; SAML: SAML attr; LDAP: memberOf array. */
  groupsClaim: unknown;
  mappings: GroupMapping[] | null;
}

/**
 * Resolve `mappings` against the user's group set into a permission-bearing
 * `AbilitySource[]`. Stateless except for one read against `roles` to
 * inline the role's permissions per matched mapping.
 *
 * Returns `{ derived: [], unresolved: [] }` when the provider has no
 * mappings configured — the groups claim is irrelevant in that case
 * (admin issues every assignment).
 */
export async function computeGroupSync(input: ComputeGroupSyncInput): Promise<GroupSyncResult> {
  if (!input.mappings || input.mappings.length === 0) {
    return { derived: [], unresolved: [] };
  }

  const groupSet = readGroupClaim(input.groupsClaim);
  const matching = input.mappings.filter((m) => groupSet.has(m.group));
  if (matching.length === 0) {
    return { derived: [], unresolved: [] };
  }

  // One round-trip to inline the role's permission list per mapping.
  // We could narrow the `roles` read to the matched slugs only, but the
  // table is small and roles are heavily cached in practice.
  const wantedSlugs = new Set(matching.map((m) => m.roleSlug));
  const roleRows = await db
    .select({ slug: roles.slug, permissions: roles.permissions })
    .from(roles);
  const permsBySlug = new Map<string, readonly Permission[]>();
  for (const r of roleRows) {
    if (wantedSlugs.has(r.slug)) {
      permsBySlug.set(r.slug, r.permissions as readonly Permission[]);
    }
  }

  const derived: DerivedAbilitySource[] = [];
  const unresolved: UnresolvedGroupMapping[] = [];
  for (const m of matching) {
    const perms = permsBySlug.get(m.roleSlug);
    if (!perms) {
      unresolved.push({ group: m.group, roleSlug: m.roleSlug, reason: "role-slug-not-found" });
      continue;
    }
    derived.push({
      permissions: perms,
      scopeType: m.scopeType,
      scopeId: m.scopeId,
    });
  }

  return { derived, unresolved };
}
