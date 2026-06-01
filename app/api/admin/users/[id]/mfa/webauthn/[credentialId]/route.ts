/**
 * app/api/admin/users/[id]/mfa/webauthn/[credentialId]/route.ts
 *
 * DELETE - admin removes ONE WebAuthn credential from a target user's
 * account. Use case: user lost a physical security key and can't reach
 * the self-service profile page (e.g. it was their only factor).
 *
 * Gate: `user.update`. TARGET-privilege ceiling enforced - same as the
 * TOTP admin reset (lib/rbac/target-ceiling) so a low-privilege
 * `user.update` holder can't strip a credential from an account that
 * holds permissions they don't.
 *
 * Selective (per-credential) rather than blanket: a user with three
 * passkeys can have the lost one dropped while keeping the other two.
 * If the target's roles require MFA AND no factors remain after this
 * call, the user will be shunted to forced re-enrollment on their next
 * request (the (app) layout compliance check handles that).
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findCredentialById, removeCredential } from "@/lib/db/repositories/webauthn";
import { findUserById } from "@/lib/db/repositories/users";
import { loadUserAssignmentsForAbility } from "@/lib/db/repositories/roles";
import { globalPermissionsOf, type AbilitySource } from "@/lib/rbac/ability";
import { permissionsTargetHoldsBeyondActor } from "@/lib/rbac/target-ceiling";
import { env } from "@/lib/env";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string; credentialId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    if (!env.WEBAUTHN_ENABLED) {
      throw new ForbiddenError("WebAuthn is disabled by configuration.");
    }

    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id, credentialId } = await context.params;

    const target = await findUserById(id);
    if (!target) throw new NotFoundError("User not found.");

    const actorGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(actor.id)) as readonly AbilitySource[],
    );
    const targetGlobal = globalPermissionsOf(
      (await loadUserAssignmentsForAbility(target.id)) as readonly AbilitySource[],
    );
    if (permissionsTargetHoldsBeyondActor(actorGlobal, targetGlobal).length > 0) {
      throw new ForbiddenError(
        "You can't remove a passkey from a user who holds permissions you don't hold globally.",
      );
    }

    const existing = await findCredentialById(id, credentialId);
    if (!existing) throw new NotFoundError("Credential not found on this account.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await removeCredential(id, credentialId, tx);
      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "auth.mfa.webauthn.removed",
          resource: { type: "user", id },
          before: {
            credentialId: existing.id,
            nickname: existing.nickname,
            transports: existing.transports ?? [],
          },
          after: { byAdmin: true },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.users.mfa.webauthn.delete.error");
  }
}
