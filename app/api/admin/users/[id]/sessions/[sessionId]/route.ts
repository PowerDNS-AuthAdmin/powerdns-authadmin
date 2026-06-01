/**
 * app/api/admin/users/[id]/sessions/[sessionId]/route.ts
 *
 * DELETE - revoke a single session belonging to the named user.
 * Useful when an operator wants to kick a specific device (e.g. "I
 * see a stale browser from a hotel network in the user's session
 * list") without forcing a global re-login.
 *
 * Cross-user safety: the session row's `userId` must match the
 * URL's `id`. We won't let an admin accidentally kill someone
 * else's session by guessing IDs from one user's URL.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findUserById } from "@/lib/db/repositories/users";
import { findValidSessionById, revokeSession } from "@/lib/db/repositories/sessions";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string; sessionId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id, sessionId } = await context.params;

    const target = await findUserById(id);
    if (!target) throw new NotFoundError("User not found.");

    const session = await findValidSessionById(sessionId);
    // Treat "session belongs to a different user" identically to
    // "session not found" so this endpoint can't be used to probe
    // session IDs across users.
    if (session?.userId !== id) {
      throw new NotFoundError("Session not found.");
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await revokeSession(sessionId, tx);

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.session.revoked",
          resource: { type: "user", id },
          after: { sessionId },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.users.sessions.sessionId.route.error");
  }
}
