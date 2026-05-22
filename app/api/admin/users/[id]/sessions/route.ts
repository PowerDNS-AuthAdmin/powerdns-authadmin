/**
 * app/api/admin/users/[id]/sessions/route.ts
 *
 * DELETE — revoke EVERY active session for the named user (incident
 * response: stolen laptop, suspected credential compromise, etc.).
 * Distinct from the user-disable flow because the operator can leave
 * the account active and let the user re-authenticate after their
 * password is reset / device is recovered.
 *
 * Gate: `user.update` permission on the target user. Admins can
 * revoke their own sessions through this endpoint too — useful for
 * the "I'm leaving my workstation, sign me out everywhere" flow even
 * though /profile already exposes per-session controls.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findUserById } from "@/lib/db/repositories/users";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id } = await context.params;

    const target = await findUserById(id);
    if (!target) throw new NotFoundError("User not found.");

    const hdrs = await headers();
    const revoked = await db.transaction(async (tx) => {
      const count = await revokeSessionsForUser(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.sessions.revoked",
          resource: { type: "user", id },
          after: { revokedCount: count },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return count;
    });

    return Response.json({ ok: true, revoked });
  } catch (err) {
    return errorResponse(err, "admin.users.sessions.route.error");
  }
}
