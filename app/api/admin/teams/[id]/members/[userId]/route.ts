/**
 * app/api/admin/teams/[id]/members/[userId]/route.ts
 *
 * PATCH  — change a member's team role (owner/member).
 * DELETE — remove a member from the team.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { removeTeamMember, updateTeamMemberRole } from "@/lib/db/repositories/teams";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string; userId: string }>;
}

const patchSchema = z.object({
  teamRole: z.enum(["owner", "member"]),
});

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId, userId } = await context.params;
    const { user: actor } = await requireUser({
      can: "team.manage-members",
      on: { __type: "Team", id: teamId },
    });
    await requireCsrf(request);

    let input;
    try {
      input = patchSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.");
      }
      throw err;
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const updated = await updateTeamMemberRole(teamId, userId, input.teamRole, tx);
      if (!updated) throw new NotFoundError("Membership not found.");

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.member.added", // role change is logged as a re-add for now
          resource: { type: "team", id: teamId },
          after: { userId, teamRole: input.teamRole },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.teams.members.userId.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId, userId } = await context.params;
    const { user: actor } = await requireUser({
      can: "team.manage-members",
      on: { __type: "Team", id: teamId },
    });
    await requireCsrf(request);

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await removeTeamMember(teamId, userId, tx);

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.member.removed",
          resource: { type: "team", id: teamId },
          before: { userId },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.teams.members.userId.route.error");
  }
}
