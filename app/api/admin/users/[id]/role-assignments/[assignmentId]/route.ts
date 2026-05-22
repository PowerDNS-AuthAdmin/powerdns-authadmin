/**
 * app/api/admin/users/[id]/role-assignments/[assignmentId]/route.ts
 *
 * DELETE — remove a role assignment. Permission: role.assign.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { deleteRoleAssignment } from "@/lib/db/repositories/roles";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string; assignmentId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "role.assign" });
    await requireCsrf(request);
    const { id: userId, assignmentId } = await context.params;

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      // Scope the delete to this user — guards against deleting another
      // user's assignment by supplying a mismatched [id]/[assignmentId] pair.
      const deleted = await deleteRoleAssignment(assignmentId, userId, tx);
      if (!deleted) throw new NotFoundError("Role assignment not found.");

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "role.assignment.deleted",
          resource: { type: "user", id: userId },
          before: { assignmentId },
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
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
