/**
 * app/api/admin/sessions/route.ts
 *
 * DELETE — incident-response action: wipe every session in the
 * database, forcing every signed-in user to re-authenticate. Use
 * when a leak / compromise affects credentials at scale (config
 * leak, infra compromise, suspected credential dump).
 *
 * Defaults to SPARING the actor's own current session so the
 * operator doesn't lose the audit-log window mid-investigation by
 * locking themselves out. Pass `?include-self=1` to revoke their
 * own session too — useful when the operator wants the same
 * sign-back-in friction everyone else gets.
 *
 * Gate: `user.update` (same perm as per-user revoke).
 * Token-auth callers also need it; the route doesn't try to
 * distinguish "PAT-driven IR" from "operator-driven IR" since the
 * audit row records the actor either way.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { revokeAllSessions } from "@/lib/db/repositories/sessions";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);

    const url = new URL(request.url);
    const includeSelf = url.searchParams.get("include-self") === "1";

    // Read the actor's session row so we know which one to spare.
    // Token-auth actors don't have a session row — for them
    // `current` is null and the route reduces to a full wipe (which
    // can't lock them out anyway since they auth by token).
    const current = await readSession();
    const exceptId = !includeSelf && current ? current.id : undefined;

    const hdrs = await headers();
    const revoked = await db.transaction(async (tx) => {
      const count = await revokeAllSessions(exceptId, tx);

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.sessions.revoked_all",
          resource: { type: "audit", id: null },
          after: {
            revokedCount: count,
            includeSelf,
            // Capture whether we spared the actor's session — operators
            // reviewing the audit row later see exactly what scope the
            // action had.
            sparedSessionId: exceptId ?? null,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return count;
    });

    return Response.json({ ok: true, revoked });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof ValidationError)
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
