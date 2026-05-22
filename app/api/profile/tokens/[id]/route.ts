/**
 * app/api/profile/tokens/[id]/route.ts
 *
 * DELETE — revoke the caller's own token. Soft-delete (sets
 *          `revokedAt`); the row stays for audit correlation. The
 *          WHERE clause matches BOTH token id AND user id so a
 *          mis-routed call can't revoke someone else's token.
 *
 * Permission: any authenticated user (on their own tokens only).
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { revokeApiToken } from "@/lib/db/repositories/api-tokens";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);
    const { id } = await context.params;

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const revoked = await revokeApiToken({ id, userId: user.id }, tx);
      if (!revoked) {
        throw new NotFoundError("Token not found.");
      }

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "auth.token.revoked",
          resource: { type: "api-token", id: revoked.id },
          before: {
            name: revoked.name,
            prefix: revoked.prefix,
            scopes: revoked.scopes,
          },
          after: { revokedAt: revoked.revokedAt?.toISOString() ?? null },
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
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "profile.tokens.delete.route.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
