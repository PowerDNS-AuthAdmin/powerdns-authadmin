/**
 * lib/rbac/ability.ts
 *
 * Build a CASL `Ability` from a user's effective role assignments + scopes.
 *
 * CASL's model:
 *   ability.can(action, subject) — where subject is either a *type name*
 *   (string like "Zone") or an *instance* (object with a `__type` field).
 *
 * Our adapter:
 *   - "Actions" are the second halves of our permission strings ("read",
 *     "create", "update", "delete", "configure", ...).
 *   - "Subject types" are the first halves capitalized ("Zone", "Record",
 *     "Dnssec", ...). See `SubjectType` below.
 *   - At rule definition time (`AbilityBuilder.can(...)`) we pass the subject
 *     *type name*. CASL types require this — passing the instance type union
 *     here doesn't typecheck.
 *   - At check time (`ability.can(...)`), callers may pass either a subject
 *     type name (existence check) or an instance (scoped check). The
 *     `detectSubjectType` callback below maps an instance to its type name.
 *   - Scope is matched per resource via CASL's `conditions` mechanism: a
 *     team-scoped assignment grants the action only when the resource's
 *     `teamId` (for zones/records) or `id` (for teams) matches the scope.
 *
 * The ability is built once per request, cached on the request context, and
 * passed to `lib/rbac/policy.ts`'s `can()` helper.
 */

import "server-only";
import { AbilityBuilder, createMongoAbility, type MongoAbility } from "@casl/ability";
import type { Permission } from "./permissions";

/**
 * The names of every subject type we authorize against. Used by CASL at rule
 * definition time and as the second arg to `ability.can()` for type-level
 * checks ("can the user do X to *any* Zone?").
 */
export type SubjectType =
  | "Zone"
  | "Record"
  | "Dnssec"
  | "Metadata"
  | "Tsig"
  | "Autoprimary"
  | "Template"
  | "User"
  | "Team"
  | "Role"
  | "Server"
  | "Token"
  | "Audit"
  | "Settings"
  | "Auth"
  | "System";

/**
 * The shape of a resource instance we pass at check time. The `__type` field
 * discriminates the subject type — `detectSubjectType` reads it.
 */
export type SubjectInstance =
  | { __type: "Zone"; id: string; teamId: string }
  | { __type: "Record"; zoneId: string; teamId: string }
  | { __type: "Team"; id: string }
  | { __type: "User"; id: string }
  | { __type: "Token"; userId: string };

/**
 * Either form — what route handlers pass to `can()` / `requirePermission()`.
 * Type-level checks use the string form; per-resource checks use the instance.
 */
export type Subject = SubjectType | SubjectInstance;

/** Action half of a permission. */
export type Action = string;

export type AppAbility = MongoAbility<[Action, Subject]>;

/**
 * One entry in the input to `buildAbility`. Each role assignment expands into
 * one or more CASL rules — the assignment's permissions × the resource type
 * the action applies to, scoped by the assignment's scope_type/scope_id.
 */
export interface AbilitySource {
  permissions: readonly Permission[];
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}

/**
 * Map a permission string to (action, subjectType). Subject type names match
 * the `SubjectType` union by construction — they're the capitalized resource
 * half of the permission string.
 */
function splitPermission(p: Permission): {
  action: string;
  subjectType: SubjectType;
} {
  const [resource, ...rest] = p.split(".");
  const action = rest.join(".");
  // The cast is safe: every permission string in `PERMISSIONS` starts with a
  // resource name that maps to a SubjectType. Validated implicitly by the
  // `permissions.ts` test (every permission listed there has a matching
  // SubjectType entry).
  const subjectType = (resource![0]!.toUpperCase() + resource!.slice(1)) as SubjectType;
  return { action, subjectType };
}

/**
 * Build a CASL ability from one or more role assignments.
 *
 * Resource-shape contract (what to pass at `.can()` check time):
 *   - Zone instances must carry `__type: "Zone"`, `id`, and `teamId`.
 *   - Record instances must carry `__type: "Record"`, `zoneId`, and `teamId`.
 *   - Team instances must carry `__type: "Team"` and `id`.
 *   - …and so on. Pass either the bare subject-type string for an existence
 *     check ("can the user do X to *any* Zone?") or the full instance for a
 *     scoped check.
 *
 * @example
 *   const ability = buildAbility([
 *     { permissions: ["zone.read","record.update"], scopeType: "team", scopeId: "team-uuid" },
 *   ]);
 *   ability.can("read", { __type: "Zone", id: "z", teamId: "team-uuid" }); // → true
 *   ability.can("read", { __type: "Zone", id: "z", teamId: "other-team" }); // → false
 */
export function buildAbility(sources: readonly AbilitySource[]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);

  for (const src of sources) {
    for (const perm of src.permissions) {
      const { action, subjectType } = splitPermission(perm);

      switch (src.scopeType) {
        case "global":
          can(action, subjectType);
          break;

        case "team":
          if (src.scopeId === null) continue;
          // Zone / Record / Team subjects all carry a teamId or are a team.
          if (subjectType === "Zone" || subjectType === "Record") {
            can(action, subjectType, { teamId: src.scopeId });
          } else if (subjectType === "Team") {
            can(action, subjectType, { id: src.scopeId });
          } else {
            // Team-scoped role on a non-team-bound resource (e.g. "Audit" or
            // "User"). Don't grant — team scope is meaningless for it.
          }
          break;

        case "zone":
          if (src.scopeId === null) continue;
          if (subjectType === "Zone") {
            can(action, subjectType, { id: src.scopeId });
          } else if (subjectType === "Record") {
            can(action, subjectType, { zoneId: src.scopeId });
          }
          break;

        case "server":
          if (src.scopeId === null) continue;
          if (subjectType === "Server") {
            can(action, subjectType, { id: src.scopeId });
          } else if (subjectType === "Zone" || subjectType === "Record") {
            // future work — Zone/Record carry a serverId; we'll grant by that
            // once the schema has it. No-op for now.
          }
          break;
      }
    }
  }

  return build({
    // Detect the subject type from our `__type` discriminator. CASL types
    // this as `ExtractSubjectType<Subject>` (= our `SubjectType`); we cast
    // because the discriminator field is typed as a bare string at runtime.
    detectSubjectType: (subject) => {
      if (typeof subject === "string") return subject;
      if (subject && typeof subject === "object" && "__type" in subject) {
        return (subject as { __type: SubjectType }).__type;
      }
      // Default fallback — should never hit if call sites use the helper.
      return "Settings";
    },
  });
}

/**
 * The set of permissions a user holds at **global** scope.
 *
 * Why this exists separately from the CASL ability: a *type-level* CASL check
 * (`ability.can("update", "Record")` with a bare subject string) answers "can
 * the user do this to *some* instance?" — so it returns `true` for a rule that
 * is conditionally scoped to one team/zone/server. That makes it unsafe as a
 * blanket ("any instance") authorization decision: a team-scoped Operator
 * would pass `ability.can("update", "Record")` and appear to have access to
 * every zone on every backend.
 *
 * A genuine "all instances" capability is exactly a **global** grant. Callers
 * that must make an all-instances decision (zone/record/dnssec/metadata
 * operations — which have no zone→team mapping and are gated per-zone by
 * `zone_grants` instead — plus zone/server *creation* and admin-wide list
 * endpoints) consult this set. Callers holding a concrete resource pass a
 * subject instance to `ability.can` for a properly scoped check.
 */
export function globalPermissionsOf(sources: readonly AbilitySource[]): ReadonlySet<Permission> {
  const out = new Set<Permission>();
  for (const src of sources) {
    if (src.scopeType === "global") {
      for (const p of src.permissions) out.add(p);
    }
  }
  return out;
}

/**
 * The privilege ceiling for role assignment (L-3): the permissions a role would
 * grant that the actor does NOT already hold globally. An actor may only assign
 * a role whose permission set is a subset of their own global permissions —
 * otherwise a holder of `role.assign` could grant SuperAdmin (or any permission
 * they lack) to others or themselves, escalating past their own authority. The
 * assignment route is global-only (`requireUser` checks the global grant), so
 * the actor's *global* permission set is the correct comparison basis. An empty
 * result means the assignment is within the ceiling.
 */
export function permissionsExceedingGrant(
  actorGlobalPermissions: ReadonlySet<Permission>,
  rolePermissions: readonly Permission[],
): Permission[] {
  return rolePermissions.filter((p) => !actorGlobalPermissions.has(p));
}

/**
 * One OIDC group→role mapping resolved to the permission set its target role
 * grants. `roleSlug` is carried through so an over-ceiling rejection can name
 * the offending mapping.
 */
export interface ResolvedGroupMapping {
  group: string;
  roleSlug: string;
  permissions: readonly Permission[];
}

/** A mapping that would grant permissions the acting user lacks globally. */
export interface GroupMappingViolation {
  group: string;
  roleSlug: string;
  exceeding: Permission[];
}

/**
 * The privilege ceiling for OIDC group→role mappings (GHSA-wf29-rmhc-rqc9).
 *
 * A `oidc.manage` holder configures rules that, at a stranger's first sign-in,
 * mint role assignments for them. Without a ceiling, an operator who lacks
 * (say) `user.delete` could wire a `superusers` group to the Super Admin role
 * and then escalate by logging in through that group — laundering privilege
 * through the IdP. So every mapping's target role must be a subset of what the
 * acting user already holds **globally**, exactly as role assignment is gated
 * (`permissionsExceedingGrant`). Scope on the mapping doesn't relax this: a
 * mapping can land permissions on the user, so the global set is the basis
 * regardless of the mapping's own scope.
 *
 * Returns one entry per offending mapping (empty = the whole set is within the
 * ceiling). Reuses `permissionsExceedingGrant` so the comparison rule stays in
 * one place.
 */
export function groupMappingsExceedingGrant(
  actorGlobalPermissions: ReadonlySet<Permission>,
  mappings: readonly ResolvedGroupMapping[],
): GroupMappingViolation[] {
  const violations: GroupMappingViolation[] = [];
  for (const m of mappings) {
    const exceeding = permissionsExceedingGrant(actorGlobalPermissions, m.permissions);
    if (exceeding.length > 0) {
      violations.push({ group: m.group, roleSlug: m.roleSlug, exceeding });
    }
  }
  return violations;
}
