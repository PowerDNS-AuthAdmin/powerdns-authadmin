/**
 * app/api/admin/teams/[id]/route.ts
 *
 * PATCH  - update team fields (team.update).
 * DELETE - remove a team (team.delete). Cascades members; role assignments
 *          referencing the team via scope_id are NOT auto-cleaned (no FK on
 *          scope_id by design - see role-assignments.ts comment). The
 *          assignments simply stop matching anything once the team is gone.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { deleteTeam, findTeamById, updateTeam } from "@/lib/db/repositories/teams";
import { updateTeamSchema } from "@/lib/validators/teams";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    // Instance-scoped check: a team-scoped Team Owner may edit only their
    // own team; a global grant matches any team.
    const { user: actor } = await requireUser({
      can: "team.update",
      on: { __type: "Team", id },
    });
    await requireCsrf(request);

    const existing = await findTeamById(id);
    if (!existing) throw new NotFoundError("Team not found.");

    let input;
    try {
      input = updateTeamSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const patch: Parameters<typeof updateTeam>[1] = {};
    if (input.slug !== undefined) patch.slug = input.slug;
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined)
      patch.description = input.description === "" ? null : (input.description ?? null);
    if (input.contact !== undefined)
      patch.contact = input.contact === "" ? null : (input.contact ?? null);
    if (input.mail !== undefined) patch.mail = input.mail === "" ? null : (input.mail ?? null);

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateTeam(id, patch, tx);
      if (!row) throw new NotFoundError("Team not found.");

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.update",
          resource: { type: "team", id },
          before: existing,
          after: row,
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return row;
    });

    return Response.json({ team: updated });
  } catch (err) {
    return errorResponse(err, "admin.teams.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    const { user: actor } = await requireUser({
      can: "team.delete",
      on: { __type: "Team", id },
    });
    await requireCsrf(request);
    const existing = await findTeamById(id);
    if (!existing) throw new NotFoundError("Team not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteTeam(id, tx);
      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.delete",
          resource: { type: "team", id },
          before: existing,
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.teams.id.route.error");
  }
}
