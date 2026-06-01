/**
 * lib/rbac/oidc-mapping-ceiling.ts
 *
 * Route-side guard for the OIDC group→role privilege ceiling
 * (GHSA-wf29-rmhc-rqc9). Resolves each group mapping's `roleSlug` to the
 * permission set its role grants, computes the acting user's GLOBAL
 * permissions, and throws if any mapping would mint permissions the actor
 * doesn't already hold globally - the same ceiling role *assignment* enforces
 * (`permissionsExceedingGrant`), just applied to the rules that auto-assign
 * roles at first sign-in.
 *
 * The pure comparison lives in `ability.ts` (`groupMappingsExceedingGrant`) so
 * it stays unit-testable without a DB; this module is the thin DB-backed
 * wrapper the routes call.
 */

import "server-only";
import { findRolesBySlugs, loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { ValidationError } from "@/lib/errors";
import {
  globalPermissionsOf,
  groupMappingsExceedingGrant,
  type AbilitySource,
  type ResolvedGroupMapping,
} from "./ability";
import type { Permission } from "./permissions";

/** The mapping shape the OIDC validator produces (subset we care about here). */
export interface GroupMappingInput {
  group: string;
  roleSlug: string;
}

/**
 * Reject the request unless every group mapping's target role is within the
 * acting user's global permission ceiling.
 *
 * Throws `ValidationError` when:
 *   - a mapping references a role slug that doesn't exist (so the ceiling can't
 *     be evaluated - a non-resolvable mapping is invalid input), or
 *   - any mapping's role grants a permission the actor lacks globally (the
 *     escalation the advisory describes).
 *
 * A `null`/empty mapping list is a no-op.
 */
export async function assertGroupMappingsWithinCeiling(
  actorId: string,
  mappings: readonly GroupMappingInput[] | null | undefined,
): Promise<void> {
  if (!mappings || mappings.length === 0) return;

  const slugs = Array.from(new Set(mappings.map((m) => m.roleSlug)));
  const roles = await findRolesBySlugs(slugs);
  const permsBySlug = new Map<string, readonly Permission[]>(
    // The DB column is structurally string[]; values are validated as
    // permissions at role write time. Cast mirrors the role-assignment route.
    roles.map((r) => [r.slug, r.permissions as readonly Permission[]]),
  );

  const missing = slugs.filter((s) => !permsBySlug.has(s));
  if (missing.length > 0) {
    throw new ValidationError(`Group mapping references unknown role(s): ${missing.join(", ")}.`);
  }

  const resolved: ResolvedGroupMapping[] = mappings.map((m) => ({
    group: m.group,
    roleSlug: m.roleSlug,
    permissions: permsBySlug.get(m.roleSlug) ?? [],
  }));

  // `oidc.manage` is global-only, so the actor's global permission set is the
  // correct basis - matching the role-assignment route's reasoning.
  const actorSources = (await loadUserAssignmentsForAbility(actorId)) as readonly AbilitySource[];
  const actorGlobal = globalPermissionsOf(actorSources);

  const violations = groupMappingsExceedingGrant(actorGlobal, resolved);
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `${v.roleSlug} (group "${v.group}") grants ${v.exceeding.join(", ")}`)
      .join("; ");
    throw new ValidationError(
      `You can't create an OIDC group mapping to a role that grants permissions you don't hold globally: ${detail}.`,
    );
  }
}
