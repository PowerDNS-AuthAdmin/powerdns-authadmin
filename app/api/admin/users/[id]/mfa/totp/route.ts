/**
 * app/api/admin/users/[id]/mfa/totp/route.ts
 *
 * DELETE - admin removes a target user's TOTP enrollment. Use case:
 * the user lost their authenticator device and can't sign in. Before
 * this endpoint existed the operator had to `UPDATE users SET
 * totp_secret_encrypted = NULL` directly; that's both bad UX and
 * unaudited.
 *
 * Gate: `user.update`. If the target's role(s) require MFA the user
 * will land on the forced-enrollment flow on their next request
 * (`(app)/layout.tsx` runs `checkMfaCompliance`), so removing the
 * enrollment doesn't leave them in a non-compliant state forever - it
 * just shunts them back to /profile to re-enroll.
 *
 * Self-target intentionally permitted: if an admin is fighting their
 * own lost-device situation and a peer can't help yet, they can use
 * this endpoint on themselves; the audit row still records the
 * actor=target identity collision.
 */

import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { findUserById } from "@/lib/db/repositories/users";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { globalPermissionsOf, type AbilitySource } from "@/lib/rbac/ability";
import { permissionsTargetHoldsBeyondActor } from "@/lib/rbac/target-ceiling";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
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

    // TARGET-privilege ceiling: stripping a user's TOTP weakens their account
    // security, so a `user.update` holder must not be able to do it to an
    // account holding global permissions the actor lacks. Self-target passes
    // (identical sets) - the lost-device self-service case stays open. Cast: the
    // DB column is structurally string[]; values are validated at write time.
    const actorGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(actor.id)) as readonly AbilitySource[],
    );
    const targetGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(target.id)) as readonly AbilitySource[],
    );
    if (permissionsTargetHoldsBeyondActor(actorGlobal, targetGlobal).length > 0) {
      throw new ForbiddenError(
        "You can't remove MFA from a user who holds permissions you don't hold globally.",
      );
    }

    if (!target.totpSecretEncrypted) {
      throw new NotFoundError("TOTP is not enabled on this account.");
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecretEncrypted: null, updatedAt: new Date() })
        .where(eq(users.id, id));

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "auth.mfa.removed",
          resource: { type: "user", id },
          after: { method: "totp", byAdmin: true },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.users.mfa.totp.route.error");
  }
}
