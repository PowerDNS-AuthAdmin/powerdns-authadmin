/**
 * app/api/admin/users/[id]/reset-password/route.ts
 *
 * POST — generate a fresh temporary password for the target user, set
 * `mustChangePassword=true`, revoke their sessions, and return a
 * short-lived single-use reveal token. The plaintext NEVER appears in
 * this response body; the operator's UI calls the sibling `/reveal`
 * endpoint to retrieve it as `text/plain` exactly once. See S-8 in
 * reports/audit-2026-05-16.md for the threat model that motivated this
 * split (response-body capture by access loggers / SIEMs).
 *
 * future work will retire this flow entirely in favor of the signed-token
 * reset-email path  §7 specifies.
 */

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { hashPassword } from "@/lib/auth/password";
import { mint } from "@/lib/auth/temp-reveal-store";
import { db } from "@/lib/db";
import { findUserById, updateUser } from "@/lib/db/repositories/users";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { globalPermissionsOf, type AbilitySource } from "@/lib/rbac/ability";
import { permissionsTargetHoldsBeyondActor } from "@/lib/rbac/target-ceiling";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.reset-password" });
    await requireCsrf(request);
    const { id } = await context.params;

    const target = await findUserById(id);
    if (!target) throw new NotFoundError("User not found.");

    // TARGET-privilege ceiling: a `user.reset-password` holder must not be able
    // to reset the password of (then, via the sibling /reveal route, read) an
    // account holding global permissions the actor lacks — that's a takeover of
    // privileges above the actor's own. Self-target passes (identical sets).
    // Cast: the DB column is structurally string[]; values are validated at
    // write time. Keeps this free of a lib/db → lib/rbac import.
    const actorGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(actor.id)) as readonly AbilitySource[],
    );
    const targetGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(target.id)) as readonly AbilitySource[],
    );
    if (permissionsTargetHoldsBeyondActor(actorGlobal, targetGlobal).length > 0) {
      throw new ForbiddenError(
        "You can't reset the password of a user who holds permissions you don't hold globally.",
      );
    }

    // Generate a 24-byte base64url password (~32 chars). Easily strong.
    const temporary = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(temporary);

    // Stash the plaintext in the single-use in-memory store keyed to *this
    // operator*. The token returned below is the only way to retrieve it,
    // and only this operator's session can redeem it (see temp-reveal-store).
    // Minted before the tx so its `expiresInSec` can ride the audit snapshot;
    // if the tx rolls back the operator gets a 500 and the unused token simply
    // expires — it reveals a password that was never persisted.
    const { token: revealToken, expiresInSec } = await mint({
      plaintext: temporary,
      allowedActorId: actor.id,
    });

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await updateUser(
        id,
        {
          passwordHash,
          mustChangePassword: true,
        },
        tx,
      );
      await revokeSessionsForUser(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.password.reset",
          resource: { type: "user", id },
          after: {
            mustChangePassword: true,
            sessionsRevoked: true,
            revealTokenIssued: true,
            revealExpiresInSec: expiresInSec,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json(
      {
        ok: true,
        revealToken,
        expiresInSec,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
