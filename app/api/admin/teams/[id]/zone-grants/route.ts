/**
 * app/api/admin/teams/[id]/zone-grants/route.ts
 *
 * Team principal mirror of `app/api/admin/users/[id]/zone-grants/route.ts`.
 *
 * POST — issue a zone grant to the team. Flows to every member via
 *        `team_members`. Permission: `team.update`. Instance-scoped:
 *        a team-scoped Team Owner can grant only on their own team.
 * GET  — list the team's grants for the admin UI.
 *
 * The privilege ceiling is the SAME shape as the user route — operators
 * can only grant permissions they themselves effectively hold on this
 * (server, zone). Their team-inherited grants count toward the ceiling
 * (listGrantsForUser already unions team-inherited rows).
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { zoneGrants } from "@/lib/db/schema";
import {
  findTeamGrant,
  listGrantsForTeam,
  listGrantsForUser,
  mapServersToClusterPeers,
} from "@/lib/db/repositories/zone-grants";
import { findTeamById } from "@/lib/db/repositories/teams";
import { findPdnsServerById } from "@/lib/db/repositories/pdns-servers";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { globalPermissionsOf, type AbilitySource } from "@/lib/rbac/ability";
import { effectiveZonePermissions, expandGrantsAcrossClusters } from "@/lib/rbac/zone-permissions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const PERMISSION_SET = new Set<string>(PERMISSIONS);

const createSchema = z.object({
  serverId: z.string().uuid(),
  zoneName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/, "Invalid zone name."),
  permissions: z
    .array(z.string())
    .max(64)
    .refine(
      (list) => list.every((p) => PERMISSION_SET.has(p)),
      "Permissions list contains values outside the master vocabulary.",
    ),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId } = await context.params;
    await requireUser({ can: "team.read", on: { __type: "Team", id: teamId } });
    const team = await findTeamById(teamId);
    if (!team) throw new NotFoundError("Team not found.");
    const grants = await listGrantsForTeam(teamId);
    return Response.json({ grants });
  } catch (err) {
    return errorResponse(err, "admin.team-zone-grants.route.error");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId } = await context.params;
    const { user: actor } = await requireUser({
      can: "team.update",
      on: { __type: "Team", id: teamId },
    });
    await requireCsrf(request);

    const team = await findTeamById(teamId);
    if (!team) throw new NotFoundError("Team not found.");

    let input;
    try {
      input = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const zoneName = canonicalizeZoneName(input.zoneName);

    const server = await findPdnsServerById(input.serverId);
    if (!server || server.disabledAt) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    // Privilege ceiling (mirrors the user route, GHSA-gjg4-58c5-2qg3).
    // The actor must hold every permission they're granting — at global
    // scope OR via a grant of their own on this (server, zone). Team-
    // inherited grants count toward the ceiling because listGrantsForUser
    // unions them in.
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
    const actorZonePerms = effectiveZonePermissions(actorEffectiveGrants, input.serverId, zoneName);
    const exceeding = input.permissions.filter(
      (p) => !actorGlobal.has(p as (typeof PERMISSIONS)[number]) && !actorZonePerms.has(p),
    );
    if (exceeding.length > 0) {
      throw new ForbiddenError(
        `You can't grant permissions you don't hold for this zone: ${exceeding.join(", ")}.`,
      );
    }

    const existing = await findTeamGrant({
      teamId,
      serverId: input.serverId,
      zoneName,
    });
    if (existing) {
      throw new ConflictError(
        "Team already has a grant for that (server, zone). Delete the existing grant first.",
      );
    }

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(zoneGrants)
        .values({
          teamId,
          serverId: input.serverId,
          zoneName,
          permissions: input.permissions,
          createdBy: actor.id,
        })
        .returning();
      if (!inserted) throw new Error("Insert returned no row.");

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "zone.grant.create",
          resource: { type: "zone-grant", id: inserted.id },
          after: {
            teamId,
            serverId: input.serverId,
            zoneName,
            permissions: input.permissions,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return inserted;
    });

    return Response.json({ ok: true, grant: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.team-zone-grants.route.error");
  }
}

function canonicalizeZoneName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".") ? lower : `${lower}.`;
}
