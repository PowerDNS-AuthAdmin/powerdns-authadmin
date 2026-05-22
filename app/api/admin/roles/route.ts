/**
 * app/api/admin/roles/route.ts
 *
 * GET  — list every role (system + custom). Reuses `role.read` since the
 *        list page already requires it.
 * POST — create a custom role (`role.create`). System roles are never
 *        created via this route; `is_system = false` is hard-coded by
 *        `insertRole`.
 *
 * All writes are audited + CSRF-guarded. Slug collisions return 409 so the
 * UI can surface a friendlier message than the DB error.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { findRoleBySlug, insertRole, listRoles } from "@/lib/db/repositories/roles";
import { createRoleSchema } from "@/lib/validators/roles";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "role.read" });
    const rows = await listRoles();
    return Response.json({ roles: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.roles.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user, globalPermissions } = await requireUser({ can: "role.create" });
    await requireCsrf(request);

    let input;
    try {
      input = createRoleSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Privilege-escalation guard: an actor may only grant permissions they
    // themselves hold (at global scope). Without this, role.create +
    // role.assign together would let a non-superadmin mint and self-assign
    // any permission.
    const disallowed = input.permissions.filter((p) => !globalPermissions.has(p));
    if (disallowed.length > 0) {
      throw new ForbiddenError(
        `You cannot grant permissions you don't hold: ${disallowed.join(", ")}.`,
      );
    }

    const existing = await findRoleBySlug(input.slug);
    if (existing) {
      throw new ConflictError(`A role with slug "${input.slug}" already exists.`);
    }

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      const created = await insertRole(
        {
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          requiresMfa: input.requiresMfa,
          permissions: input.permissions,
          isSystem: false,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "role.create",
          resource: { type: "role", id: created.id },
          after: {
            slug: created.slug,
            name: created.name,
            description: created.description,
            requiresMfa: created.requiresMfa,
            permissions: created.permissions,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    return Response.json({ role: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.roles.route.error");
  }
}
