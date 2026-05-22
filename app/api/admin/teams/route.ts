/**
 * app/api/admin/teams/route.ts
 *
 * GET  — list teams (team.read).
 * POST — create a team (team.create).
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findTeamBySlug, insertTeam, listAllTeams } from "@/lib/db/repositories/teams";
import { createTeamSchema } from "@/lib/validators/teams";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "team.read" });
    const teams = await listAllTeams();
    return Response.json({ teams });
  } catch (err) {
    return errorResponse(err, "admin.teams.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "team.create" });
    await requireCsrf(request);

    let input;
    try {
      input = createTeamSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const existing = await findTeamBySlug(input.slug);
    if (existing) throw new ConflictError("A team with that slug exists.");

    const hdrs = await headers();
    const team = await db.transaction(async (tx) => {
      const created = await insertTeam(
        {
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          contact: input.contact ?? null,
          mail: input.mail === "" ? null : (input.mail ?? null),
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "team.create",
          resource: { type: "team", id: created.id },
          after: { slug: created.slug, name: created.name },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    return Response.json({ team }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.teams.route.error");
  }
}
