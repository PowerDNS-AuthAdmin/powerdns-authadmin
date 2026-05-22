/**
 * app/api/profile/name/route.ts
 *
 * PATCH { name } — let the signed-in user edit their own display
 * name. Empty string is treated as a clear (null). No permission
 * gate — this is self-service; auth is the only requirement.
 *
 * Kept narrow to the name field. A future "edit my profile" route
 * for multiple fields would deserve a separate body schema; the
 * narrow shape here makes the audit row's before/after diff trivial
 * to read.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findUserById, updateUser } from "@/lib/db/repositories/users";
import { profileNameSchema } from "@/lib/validators/users";
import { ForbiddenError, UnauthorizedError, ValidationError } from "@/lib/errors";

export async function PATCH(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser();
    await requireCsrf(request);

    let input;
    try {
      input = profileNameSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Normalize empty string → null so the DB stores the "no name set"
    // intent consistently with the original signup state.
    const normalizedName =
      input.name === null || input.name.trim() === "" ? null : input.name.trim();

    const fresh = await findUserById(user.id);
    if (!fresh) throw new UnauthorizedError();

    // No-op short-circuit: avoid an audit row + DB write when the
    // submitted value matches what's already stored. Same pattern as
    // the role-edit MFA toggle.
    if (fresh.name === normalizedName) {
      return Response.json({ ok: true, name: normalizedName });
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const updated = await updateUser(user.id, { name: normalizedName }, tx);
      if (!updated) throw new UnauthorizedError();

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "user.update",
          resource: { type: "user", id: user.id },
          before: { name: fresh.name },
          after: { name: normalizedName },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true, name: normalizedName });
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
