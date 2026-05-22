/**
 * app/api/admin/users/[id]/route.ts
 *
 * PATCH  — edit name, disable/enable, force-password-change flag.
 * DELETE — hard-delete (cascades sessions, role assignments).
 *
 * Refuses to disable or delete the actor's own account — losing the only
 * SuperAdmin is a footgun we don't enable.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { deleteUserById, findUserById, updateUser } from "@/lib/db/repositories/users";
import { revokeSessionsForUser } from "@/lib/db/repositories/sessions";
import { updateUserSchema } from "@/lib/validators/users";
import { NotFoundError, ValidationError } from "@/lib/errors";
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

    const patch: Parameters<typeof updateUser>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.mustChangePassword !== undefined) patch.mustChangePassword = input.mustChangePassword;
    if (input.mfaRequired !== undefined) patch.mfaRequired = input.mfaRequired;
    if (input.disabled !== undefined) {
      patch.disabledAt = input.disabled ? new Date() : null;
    }

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const u = await updateUser(id, patch, tx);
      if (!u) throw new NotFoundError("User not found.");

      // Disabling a user immediately revokes their sessions so the change
      // takes effect on the next request anywhere — not just when their
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

    const hdrs = await headers();
    await db.transaction(async (tx) => {
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
