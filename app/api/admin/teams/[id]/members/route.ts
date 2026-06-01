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
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

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
