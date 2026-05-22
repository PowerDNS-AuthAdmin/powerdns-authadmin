/**
 * app/api/admin/roles/[id]/route.ts
 *
 * PATCH  — update a role's mutable attributes (name, description,
 *          requiresMfa, permissions). System roles accept only the
 *          `requiresMfa` toggle; every other field is rejected on
 *          `is_system = true` rows so the seeded vocabulary stays
 *          predictable across deployments.
 * DELETE — drop a custom role. System roles refuse with 400. Roles
 *          still referenced by `role_assignments` refuse with 409 and a
 *          friendly count message — the operator must revoke the
 *          assignments first.
 *
 * All mutations are audited + CSRF-guarded.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  countAssignmentsForRole,
  deleteRole,
  findRoleById,
  updateRoleAttrs,
} from "@/lib/db/repositories/roles";
import { updateRoleSchema } from "@/lib/validators/roles";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions } = await requireUser({ can: "role.update" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findRoleById(id);
    if (!existing) throw new NotFoundError("Role not found.");

    let input;
    try {
      input = updateRoleSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Privilege-escalation guard: an actor may only grant permissions they
    // themselves hold (at global scope).
    if (input.permissions !== undefined) {
      const disallowed = input.permissions.filter((p) => !globalPermissions.has(p));
      if (disallowed.length > 0) {
        throw new ForbiddenError(
          `You cannot grant permissions you don't hold: ${disallowed.join(", ")}.`,
        );
      }
    }

    // System roles: only requiresMfa can be flipped. Editing name /
    // description / permissions on a system role would diverge from the
    // seed file across deployments, which is confusing for operators.
    if (existing.isSystem) {
      const disallowed = ["name", "description", "permissions"].filter((k) => k in input);
      if (disallowed.length > 0) {
        throw new ValidationError(
          `System roles only accept the requiresMfa toggle (received: ${disallowed.join(", ")}).`,
        );
      }
    }

    const before = {
      name: existing.name,
      description: existing.description,
      requiresMfa: existing.requiresMfa,
      permissions: existing.permissions,
    };

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateRoleAttrs(
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.requiresMfa !== undefined ? { requiresMfa: input.requiresMfa } : {}),
          ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
        },
        tx,
      );
      if (!row) throw new NotFoundError("Role not found.");

      const after = {
        name: row.name,
        description: row.description,
        requiresMfa: row.requiresMfa,
        permissions: row.permissions,
      };

      // No-op when nothing actually changed (admin clicks save without
      // touching anything). Skip the audit row; status stays 200.
      const changed = (Object.keys(before) as Array<keyof typeof before>).some(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      if (changed) {
        await appendAudit(
          {
            actor: { type: "user", id: actor.id },
            action: "role.update",
            resource: { type: "role", id },
            before,
            after,
            request: getRequestContext(hdrs),
          },
          tx,
        );
      }

      return row;
    });

    return Response.json({ role: updated });
  } catch (err) {
    return errorResponse(err, "admin.roles.id.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "role.delete" });
    await requireCsrf(request);
    const { id } = await context.params;

    const existing = await findRoleById(id);
    if (!existing) throw new NotFoundError("Role not found.");
    if (existing.isSystem) {
      throw new ValidationError("System roles cannot be deleted.");
    }

    const inUse = await countAssignmentsForRole(id);
    if (inUse > 0) {
      throw new ConflictError(
        `Cannot delete: ${inUse} user${inUse === 1 ? "" : "s"} still ${inUse === 1 ? "holds" : "hold"} this role. Revoke the assignments first.`,
      );
    }

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      const result = await deleteRole(id, tx);
      if (!result.ok) {
        // Defence in depth — pre-checks above already covered these.
        throw new ValidationError(`Cannot delete role: ${result.reason}.`);
      }

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "role.delete",
          resource: { type: "role", id },
          before: {
            slug: existing.slug,
            name: existing.name,
            description: existing.description,
            requiresMfa: existing.requiresMfa,
            permissions: existing.permissions,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.roles.id.route.error");
  }
}
