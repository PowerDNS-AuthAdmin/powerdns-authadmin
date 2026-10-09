/**
 * app/api/admin/teams/[id]/members/route.ts
 *
 * POST - add a member by email + role. Permission: team.manage-members.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { addTeamMember, findTeamById } from "@/lib/db/repositories/teams";
import { findUserByEmail } from "@/lib/db/repositories/users";
import { addTeamMemberSchema } from "@/lib/validators/teams";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import {
  listGrantsForTeam,
  listGrantsForUser,
  mapServersToClusterPeers,
} from "@/lib/db/repositories/zone-grants";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import type { PERMISSIONS } from "@/lib/rbac/permissions";
import { globalPermissionsOf, type AbilitySource } from "@/lib/rbac/ability";
import { effectiveZonePermissions, expandGrantsAcrossClusters } from "@/lib/rbac/zone-permissions";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId } = await context.params;
    // Instance-scoped: a team-scoped Team Owner manages only their own team.
    const { user: actor } = await requireUser({
      can: "team.manage-members",
      on: { __type: "Team", id: teamId },
    });
    await requireCsrf(request);

    const team = await findTeamById(teamId);
    if (!team) throw new NotFoundError("Team not found.");

    let input;
    try {
      input = addTeamMemberSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const user = await findUserByEmail(input.email);
    if (!user) throw new ValidationError("No user with that email.");

    // Membership inherits every zone grant the team holds, so adding a member
    // is a grant by another name. Apply the same ceiling the grant routes
    // use (GHSA-gjg4-58c5-2qg3): the actor must hold each inherited
    // permission globally or via a grant of their own on that zone. Team-
    // inherited grants count, so an existing member who owns the team passes.
    const teamGrants = await listGrantsForTeam(teamId);
    if (teamGrants.length > 0) {
      const actorSources = (await loadUserAssignmentsForAbility(
        actor.id,
      )) as readonly AbilitySource[];
      const actorGlobal = globalPermissionsOf(actorSources);
      const actorGrants = await listGrantsForUser(actor.id);
      const actorPeers = actorGrants.length
        ? await mapServersToClusterPeers(actorGrants.map((g) => g.serverId))
        : new Map<string, string[]>();
      const actorEffectiveGrants =
        actorPeers.size === 0 ? actorGrants : expandGrantsAcrossClusters(actorGrants, actorPeers);
      const exceeding = new Set<string>();
      for (const grant of teamGrants) {
        const actorZonePerms = effectiveZonePermissions(
          actorEffectiveGrants,
          grant.serverId,
          grant.zoneName,
        );
        for (const permission of grant.permissions) {
          if (
            !actorGlobal.has(permission as (typeof PERMISSIONS)[number]) &&
            !actorZonePerms.has(permission)
          ) {
            exceeding.add(`${permission} on ${grant.zoneName}`);
          }
        }
      }
      if (exceeding.size > 0) {
        throw new ForbiddenError(
          `You can't add a member to a team whose zone grants exceed your own: ${[...exceeding].join(", ")}.`,
        );
      }
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      try {
        await addTeamMember(
          {
            userId: user.id,
            teamId,
            teamRole: input.teamRole,
          },
          tx,
        );
      } catch (err: unknown) {
        // Duplicate-key on the (user_id, team_id) primary key.
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("team_members_pkey") || msg.includes("duplicate key")) {
          throw new ValidationError("That user is already a member of this team.");
        }
        throw err;
      }

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.member.added",
          resource: { type: "team", id: teamId },
          after: { userId: user.id, teamRole: input.teamRole },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.teams.members.route.error");
  }
}
