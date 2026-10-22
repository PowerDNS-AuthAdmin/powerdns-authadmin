/**
 * app/api/admin/users/[id]/role-assignments/route.ts
 *
 * POST - assign a role to a user at a scope (role.assign permission).
 *
 * A zone scope names the zone (canonical name, matched on every backend -
 * ADR-0024); it is accepted even when no backend serves the zone yet, and the
 * response then carries a `warning` the panel shows.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { assertBootstrapAdminMutable } from "@/lib/auth/bootstrap-admin";
import { db } from "@/lib/db";
import {
  createRoleAssignment,
  findRoleById,
  loadUserAssignmentsForAbility,
} from "@/lib/db/repositories/roles";
import { findUserById } from "@/lib/db/repositories/users";
import { findTeamById } from "@/lib/db/repositories/teams";
import { findPdnsServerById, listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { unknownZoneTargetsFor } from "@/lib/realtime/unknown-zone-targets";
import { displayZoneName } from "@/lib/dns/zone-name";
import {
  globalPermissionsOf,
  permissionsExceedingGrant,
  type AbilitySource,
} from "@/lib/rbac/ability";
import type { Permission } from "@/lib/rbac/permissions";
import { roleAssignmentSchema } from "@/lib/validators/users";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "role.assign" });
    await requireCsrf(request);
    const { id: userId } = await context.params;

    const target = await findUserById(userId);
    if (!target) throw new NotFoundError("User not found.");
    // Freezing the demo login's roles is part of the RO identity lock - a
    // visitor mustn't be able to reshape the shared account's permissions.
    assertBootstrapAdminMutable(target.email);

    let input;
    try {
      input = roleAssignmentSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const role = await findRoleById(input.roleId);
    if (!role) throw new ValidationError("Role does not exist.");

    // Privilege ceiling (L-3): an actor can only grant permissions they already
    // hold globally - a `role.assign` holder must not be able to mint SuperAdmin
    // (or any permission they lack) for others or themselves. `role.assign` is
    // global-only here, so the actor's global permission set is the basis.
    // Cast mirrors get-current-user.ts: the DB column is structurally string[]
    // to avoid a lib/db → lib/rbac import; values are validated at write time.
    const actorSources = (await loadUserAssignmentsForAbility(
      actor.id,
    )) as readonly AbilitySource[];
    const exceeding = permissionsExceedingGrant(
      globalPermissionsOf(actorSources),
      role.permissions as readonly Permission[],
    );
    if (exceeding.length > 0) {
      throw new ForbiddenError(
        `You can't assign a role that grants permissions you don't hold globally: ${exceeding.join(", ")}.`,
      );
    }

    // Validate that the named scope target actually exists. A zone has no
    // local row, so a zone scope is checked against the backends below and
    // only warned about.
    if (input.scopeType === "team" && input.scopeId) {
      const team = await findTeamById(input.scopeId);
      if (!team) throw new ValidationError("Scope team does not exist.");
    }
    if (input.scopeType === "server" && input.scopeId) {
      const server = await findPdnsServerById(input.scopeId);
      if (!server) throw new ValidationError("Scope server does not exist.");
    }

    const hdrs = await headers();
    const created = await db.transaction(async (tx) => {
      const assignment = await createRoleAssignment(
        {
          userId,
          roleId: input.roleId,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          createdBy: actor.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "role.assignment.created",
          resource: { type: "user", id: userId },
          after: {
            roleId: input.roleId,
            roleSlug: role.slug,
            scopeType: input.scopeType,
            scopeId: input.scopeId ?? null,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return assignment;
    });

    const [unknownZone] =
      input.scopeType === "zone"
        ? await unknownZoneTargetsFor(
            [{ scopeType: "zone", scopeId: input.scopeId ?? null }],
            await listAllPdnsServers(),
          )
        : [];
    return Response.json(
      {
        assignment: created,
        ...(unknownZone
          ? {
              warning: `No backend serves ${displayZoneName(unknownZone)} yet - the assignment grants nothing until that zone exists.`,
            }
          : {}),
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "admin.users.role-assignments.route.error");
  }
}
