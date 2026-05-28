/**
 * app/api/admin/teams/[id]/zone-grants/[grantId]/route.ts
 *
 * DELETE — revoke a single team zone grant. Permission: `team.update`,
 *          instance-scoped to the team. The grant id is matched against
 *          the team_id in the path so a mis-routed call can't revoke a
 *          grant on a different team.
 */

import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { zoneGrants } from "@/lib/db/schema";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";
import { logger } from "@/lib/logger";

interface RouteContext {
  params: Promise<{ id: string; grantId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id: teamId, grantId } = await context.params;
    const { user: actor } = await requireUser({
      can: "team.update",
      on: { __type: "Team", id: teamId },
    });
    await requireCsrf(request);

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const rows = await tx
        .delete(zoneGrants)
        .where(and(eq(zoneGrants.id, grantId), eq(zoneGrants.teamId, teamId)))
        .returning();
      const removed = rows[0];
      if (!removed) {
        throw new NotFoundError("Grant not found for this team.");
      }

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "zone.grant.delete",
          resource: { type: "zone-grant", id: removed.id },
          before: {
            teamId: removed.teamId,
            serverId: removed.serverId,
            zoneName: removed.zoneName,
            permissions: removed.permissions,
          },
          after: null,
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "admin.team-zone-grant.delete.route.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
