/**
 * app/api/auth/sessions/[id]/route.ts
 *
 * DELETE - revoke one of the signed-in user's own sessions by id. Refuses to
 * touch a session that belongs to someone else (admins use the audit log;
 * forced revocation lands later).
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findValidSessionById, revokeSession } from "@/lib/db/repositories/sessions";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);
    const { id } = await context.params;

    const session = await findValidSessionById(id);
    if (!session) throw new NotFoundError("Session not found.");
    if (session.userId !== user.id) {
      throw new ForbiddenError("Not your session.");
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await revokeSession(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.session.revoked",
          resource: { type: "session", id },
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
