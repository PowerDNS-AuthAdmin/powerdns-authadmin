/**
 * app/api/admin/users/[id]/tokens/[tokenId]/route.ts
 *
 * DELETE — admin revokes another user's API token. Use case:
 * suspected PAT compromise (token in a leaked script, lost laptop,
 * offboarded employee). Mirrors the self-service flow at
 * /api/profile/tokens/[id], but acts on behalf of `[id]` rather
 * than the caller.
 *
 * Cross-user safety: the underlying `revokeApiToken({id, userId})`
 * helper constrains the UPDATE by both columns, so a wrong-user URL
 * silently no-ops (returned as 404 here so the endpoint can't be
 * used to probe whether a token id belongs to a given user).
 *
 * Gate: `user.update`. Self-revoke through this route is allowed
 * too — useful when an operator is fighting their own compromised
 * token via the admin panel.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findUserById } from "@/lib/db/repositories/users";
import { revokeApiToken } from "@/lib/db/repositories/api-tokens";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string; tokenId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id: userId, tokenId } = await context.params;

    const target = await findUserById(userId);
    if (!target) throw new NotFoundError("User not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const revoked = await revokeApiToken({ id: tokenId, userId }, tx);
      if (!revoked) {
        // Either the token doesn't exist or belongs to a different
        // user. Same response either way so the endpoint isn't an
        // ownership oracle.
        throw new NotFoundError("Token not found.");
      }

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "auth.token.revoked",
          resource: { type: "api-token", id: revoked.id },
          before: {
            name: revoked.name,
            prefix: revoked.prefix,
            scopes: revoked.scopes,
            targetUserId: userId,
          },
          after: { revokedAt: revoked.revokedAt?.toISOString() ?? null, byAdmin: true },
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
