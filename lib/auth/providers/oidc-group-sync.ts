/**
 * lib/auth/providers/oidc-group-sync.ts
 *
 * Materialise OIDC group → role-assignment rules at sign-in time.
 *
 * Algorithm:
 *   1. Read the user's `groups` claim (claim name configured per-provider).
 *   2. Filter `provider.groupMappings` to those whose `group` is in the
 *      user's group set.
 *   3. Resolve each mapping to a concrete (userId, roleId, scopeType,
 *      scopeId) tuple. Mappings that don't resolve (missing role, missing
 *      team/server scope) are skipped and audited individually.
 *   4. Load every existing `role_assignments` row for this user where
 *      `provider_id = provider.id` — the rows previously created by this
 *      same materialisation pass.
 *   5. Diff: ADD rows present in (3) but not (4); REMOVE rows present in
 *      (4) but not (3). Admin-issued assignments (provider_id IS NULL) are
 *      never touched.
 *   6. Audit each ADD/REMOVE individually so an admin can see the
 *      group-membership trail across sign-ins.
 *
 * Pure function for the diff is exported as `diffGroupSync` for unit tests
 * — the heavy DB-touching path is `applyGroupSync`.
 */

import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { roleAssignments, roles, type OidcGroupMapping } from "@/lib/db/schema";
import { appendAudit } from "@/lib/audit/log";
import { logger } from "@/lib/logger";
import {
  diffGroupSync,
  readGroupClaim,
  type GroupSyncDiff,
  type ResolvedAssignment,
} from "./oidc-group-sync-pure";

export {
  diffGroupSync,
  readGroupClaim,
  type GroupSyncDiff,
  type ResolvedAssignment,
} from "./oidc-group-sync-pure";

interface ApplyGroupSyncInput {
  userId: string;
  providerId: string;
  providerSlug: string;
  /** Raw OIDC claim value — expected to be a string array, but defensive. */
  groupsClaim: unknown;
  mappings: OidcGroupMapping[] | null;
  /** For audit request-context propagation. */
  requestContext?: { ip: string | null; userAgent: string | null; requestId: string | null };
}

/**
 * Apply the diff. No-op when the provider has no mappings configured (the
 * groups claim is irrelevant in that case — admin issues all assignments).
 */
export async function applyGroupSync(input: ApplyGroupSyncInput): Promise<GroupSyncDiff> {
  if (!input.mappings || input.mappings.length === 0) {
    return { add: [], remove: [] };
  }

  const groupSet = readGroupClaim(input.groupsClaim);
  const matching = input.mappings.filter((m) => groupSet.has(m.group));

  // Resolve every matching mapping to a roleId. Mappings with an unknown
  // role slug are dropped with an audit row — operator typo'd a slug.
  const allRoleSlugs = Array.from(new Set(matching.map((m) => m.roleSlug)));
  const roleRows =
    allRoleSlugs.length === 0
      ? []
      : await db.select({ id: roles.id, slug: roles.slug }).from(roles);
  const idBySlug = new Map(roleRows.map((r) => [r.slug, r.id]));

  const target: ResolvedAssignment[] = [];
  for (const m of matching) {
    const roleId = idBySlug.get(m.roleSlug);
    if (!roleId) {
      await appendAudit({
        actor: { type: "system", id: null },
        action: "auth.oidc.group_sync.mapping_unresolved",
        resource: { type: "user", id: input.userId },
        after: {
          provider: input.providerSlug,
          group: m.group,
          roleSlug: m.roleSlug,
          reason: "role-slug-not-found",
        },
        request: input.requestContext,
      });
      continue;
    }
    target.push({
      roleId,
      scopeType: m.scopeType,
      scopeId: m.scopeId,
      source: m,
    });
  }

  const existing = await db
    .select({
      id: roleAssignments.id,
      roleId: roleAssignments.roleId,
      scopeType: roleAssignments.scopeType,
      scopeId: roleAssignments.scopeId,
    })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.userId, input.userId),
        eq(roleAssignments.providerId, input.providerId),
      ),
    );

  const diff = diffGroupSync(target, existing);

  for (const a of diff.add) {
    // Each insert + its audit row commit together (atomic mutation + audit).
    // Group sync stays best-effort: a failed pair is logged and the loop
    // continues so one bad mapping can't abort the whole sign-in sync.
    try {
      await db.transaction(async (tx) => {
        const rows = await tx
          .insert(roleAssignments)
          .values({
            userId: input.userId,
            roleId: a.roleId,
            scopeType: a.scopeType,
            scopeId: a.scopeId,
            createdBy: null,
            providerId: input.providerId,
          })
          .returning({ id: roleAssignments.id });
        const newId = rows[0]?.id;
        await appendAudit(
          {
            actor: { type: "system", id: null },
            action: "auth.oidc.group_sync.assignment_added",
            resource: { type: "role_assignment", id: newId ?? null },
            after: {
              provider: input.providerSlug,
              userId: input.userId,
              group: a.source.group,
              roleSlug: a.source.roleSlug,
              scopeType: a.scopeType,
              scopeId: a.scopeId,
            },
            request: input.requestContext,
          },
          tx,
        );
      });
    } catch (err) {
      logger.warn(
        {
          provider: input.providerSlug,
          userId: input.userId,
          roleId: a.roleId,
          error: err instanceof Error ? err.message : "unknown",
        },
        "auth.oidc.group_sync.assignment_add_failed",
      );
    }
  }

  for (const r of diff.remove) {
    try {
      await db.transaction(async (tx) => {
        await tx.delete(roleAssignments).where(eq(roleAssignments.id, r.id));
        await appendAudit(
          {
            actor: { type: "system", id: null },
            action: "auth.oidc.group_sync.assignment_removed",
            resource: { type: "role_assignment", id: r.id },
            before: {
              provider: input.providerSlug,
              userId: input.userId,
              roleId: r.roleId,
              scopeType: r.scopeType,
              scopeId: r.scopeId,
            },
            request: input.requestContext,
          },
          tx,
        );
      });
    } catch (err) {
      logger.warn(
        {
          provider: input.providerSlug,
          userId: input.userId,
          assignmentId: r.id,
          error: err instanceof Error ? err.message : "unknown",
        },
        "auth.oidc.group_sync.assignment_remove_failed",
      );
    }
  }

  if (diff.add.length > 0 || diff.remove.length > 0) {
    logger.info(
      {
        provider: input.providerSlug,
        userId: input.userId,
        added: diff.add.length,
        removed: diff.remove.length,
      },
      "auth.oidc.group_sync.applied",
    );
  }

  return diff;
}
