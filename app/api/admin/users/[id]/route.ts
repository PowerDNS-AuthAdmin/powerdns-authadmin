/**
 * app/api/admin/users/[id]/route.ts
 *
 * PATCH  - edit name, disable/enable, force-password-change flag.
 * DELETE - hard-delete (cascades sessions, role assignments).
 *
 * Refuses to disable or delete the actor's own account - losing the only
 * SuperAdmin is a footgun we don't enable.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { assertBootstrapAdminMutable } from "@/lib/auth/bootstrap-admin";
import { db } from "@/lib/db";
import { deleteUserById, findUserById, updateUser } from "@/lib/db/repositories/users";
import {
  countGlobalAssignmentsOfRoleSlug,
  userHoldsGlobalRoleSlug,
} from "@/lib/db/repositories/roles";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { SUPER_ADMIN_SLUG } from "@/lib/rbac/default-roles";
import { updateUserSchema } from "@/lib/validators/users";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findUserById(id);
    if (!existing) throw new NotFoundError("User not found.");
    // The bootstrap-admin RO lock freezes the demo login's identity: no
    // disable, no force-password-change, no MFA-policy flip, no rename.
    assertBootstrapAdminMutable(existing.email);

    let input;
    try {
      input = updateUserSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    if (input.disabled === true && id === actor.id) {
      throw new ValidationError("You cannot disable your own account.");
    }

    // SSO-only users have no way to enroll TOTP from the app - the IdP is the
    // second-factor authority. Forcing MFA on them would only deadlock the
    // account. Refuse the policy override here as defense-in-depth; the UI
    // already hides the control for SSO-only users.
    if (input.mfaRequired === true && existing.passwordHash === null) {
      throw new ValidationError(
        "Cannot force MFA on an SSO-only user - they have no way to enroll TOTP in this app. MFA is the responsibility of the identity provider.",
      );
    }

    const patch: Parameters<typeof updateUser>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.mustChangePassword !== undefined) patch.mustChangePassword = input.mustChangePassword;
    if (input.mfaRequired !== undefined) patch.mfaRequired = input.mfaRequired;
    if (input.disabled !== undefined) {
      patch.disabledAt = input.disabled ? new Date() : null;
    }

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      // Last-SuperAdmin guard (GHSA-86v6-w5p9-29r8): disabling the final
      // *enabled* global Super Admin would lock everyone out of user/role/
      // settings management just as surely as deleting their assignment would.
      // Only relevant when the target is currently enabled - re-disabling an
      // already-disabled account can't reduce the enabled population. The target
      // is still counted here, so `<= 1` means they're the last one. Checked
      // inside the tx so a concurrent disable/delete can't race past it (mirrors
      // the assignment-delete route).
      if (
        input.disabled === true &&
        existing.disabledAt === null &&
        (await userHoldsGlobalRoleSlug(id, SUPER_ADMIN_SLUG, tx))
      ) {
        const enabled = await countGlobalAssignmentsOfRoleSlug(SUPER_ADMIN_SLUG, tx);
        if (enabled <= 1) {
          throw new ForbiddenError("Cannot disable the last global Super Admin.");
        }
      }

      const u = await updateUser(id, patch, tx);
      if (!u) throw new NotFoundError("User not found.");

      // Disabling a user immediately revokes their sessions so the change
      // takes effect on the next request anywhere - not just when their
      // current cookie expires.
      if (input.disabled === true) {
        await revokeSessionsForUser(id, tx);
      }

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: input.disabled === true ? "user.disable" : "user.update",
          resource: { type: "user", id },
          before: snapshot(existing),
          after: snapshot(u),
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return u;
    });

    return Response.json({ user: safe(updated) });
  } catch (err) {
    return errorResponse(err, "admin.users.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.delete" });
    await requireCsrf(request);
    const { id } = await context.params;

    if (id === actor.id) {
      throw new ValidationError("You cannot delete your own account.");
    }

    const existing = await findUserById(id);
    if (!existing) throw new NotFoundError("User not found.");
    assertBootstrapAdminMutable(existing.email);

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      // Last-SuperAdmin guard (GHSA-86v6-w5p9-29r8): deleting the final enabled
      // global Super Admin locks everyone out of administration. Only relevant
      // when the target is currently enabled - a disabled account isn't part of
      // the enabled population, so deleting it can't drop the count. The target
      // is still counted here, so `<= 1` means they're the last one. Inside the
      // tx to block a concurrent disable/delete.
      if (
        existing.disabledAt === null &&
        (await userHoldsGlobalRoleSlug(id, SUPER_ADMIN_SLUG, tx))
      ) {
        const enabled = await countGlobalAssignmentsOfRoleSlug(SUPER_ADMIN_SLUG, tx);
        if (enabled <= 1) {
          throw new ForbiddenError("Cannot delete the last global Super Admin.");
        }
      }

      await deleteUserById(id, tx);
      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.delete",
          resource: { type: "user", id },
          before: snapshot(existing),
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.users.id.route.error");
  }
}

function snapshot(u: {
  id: string;
  email: string;
  name: string | null;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  mfaRequired: boolean | null;
}) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    disabled: u.disabledAt !== null,
    mustChangePassword: u.mustChangePassword,
    mfaRequired: u.mfaRequired,
  };
}

function safe(u: {
  id: string;
  email: string;
  name: string | null;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  mfaRequired: boolean | null;
}) {
  return snapshot(u);
}
