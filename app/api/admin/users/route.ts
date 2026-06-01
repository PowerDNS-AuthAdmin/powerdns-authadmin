/**
 * app/api/admin/users/route.ts
 *
 * GET  - list users (user.read).
 * POST - create a user (user.create). When `password` is omitted, the user
 *        is SSO-only. When present, `mustChangePassword` is set so the
 *        operator's choice is a one-time bootstrap.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { hashPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { findUserByEmail, insertUser, listAllUsers } from "@/lib/db/repositories/users";
import {
  createRoleAssignment,
  findRoleById,
  loadUserAssignmentsForAbility,
} from "@/lib/db/repositories/roles";
import {
  globalPermissionsOf,
  permissionsExceedingGrant,
  type AbilitySource,
} from "@/lib/rbac/ability";
import type { Permission } from "@/lib/rbac/permissions";
import { createUserSchema } from "@/lib/validators/users";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "user.read" });
    const rows = await listAllUsers();
    const safe = rows.map(safeUser);
    return Response.json({ users: safe }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.users.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user: actor, ability } = await requireUser({ can: "user.create" });
    await requireCsrf(request);

    let input;
    try {
      input = createUserSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Initial-role assignment is a separate authorization concern
    // from user creation. Verify upfront so a permission
    // error doesn't leave us with a created-but-unroled user. Role
    // is verified to exist too; bad UUID → 400 before insert.
    let initialRole = null;
    if (input.roleId) {
      if (!ability.can("assign", "Role")) {
        throw new ForbiddenError("Missing permission: role.assign");
      }
      initialRole = await findRoleById(input.roleId);
      if (!initialRole) {
        throw new ValidationError("Role does not exist.", {
          fieldErrors: { roleId: ["Role does not exist."] },
        });
      }

      // Privilege ceiling (L-3): the initial role is assigned at GLOBAL scope
      // below, so an actor must not be able to mint a user holding permissions
      // the actor lacks globally (e.g. a `user.create`+`role.assign` holder
      // bootstrapping a new Super Admin). Mirrors the `/role-assignments` POST.
      // Cast: the DB column is structurally string[]; values are validated at
      // write time. Avoids a lib/db → lib/rbac import.
      const actorSources = (await loadUserAssignmentsForAbility(
        actor.id,
      )) as readonly AbilitySource[];
      const exceeding = permissionsExceedingGrant(
        globalPermissionsOf(actorSources),
        initialRole.permissions as readonly Permission[],
      );
      if (exceeding.length > 0) {
        throw new ForbiddenError(
          `You can't assign a role that grants permissions you don't hold globally: ${exceeding.join(", ")}.`,
        );
      }
    }

    const existing = await findUserByEmail(input.email);
    if (existing) throw new ConflictError("A user with that email exists.");

    const passwordHash = input.password ? await hashPassword(input.password) : null;
    const hdrs = await headers();

    // The user insert, its audit row, and (when an initial role is set) the
    // assignment insert + its audit row all commit together or not at all - a
    // crash mid-sequence can't leave a created user with no audit trail, or an
    // unaudited role grant.
    const created = await db.transaction(async (tx) => {
      const row = await insertUser(
        {
          email: input.email,
          name: input.name ?? null,
          passwordHash,
          mustChangePassword: input.password !== undefined,
          // Local (password) accounts must verify their email like any other
          // self-service user - do NOT auto-verify on admin-set-password.
          // Password-less accounts are OIDC-bound and exempt from the
          // verification flow anyway (see the dashboard banner).
          emailVerifiedAt: null,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "user.create",
          resource: { type: "user", id: row.id },
          after: {
            email: row.email,
            name: row.name,
            ssoOnly: passwordHash === null,
            initialRoleSlug: initialRole?.slug ?? null,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      // Assignment rides along as a separate audit row so the audit
      // log shows the discrete action (matches the
      // `/role-assignments` POST shape). Done after the user-create
      // audit so the two rows land in causal order.
      if (initialRole) {
        const assignment = await createRoleAssignment(
          {
            userId: row.id,
            roleId: initialRole.id,
            scopeType: "global",
            scopeId: null,
            createdBy: actor.id,
          },
          tx,
        );
        await appendAudit(
          {
            actor: { type: "user", id: actor.id },
            action: "role.assignment.created",
            resource: { type: "user", id: row.id },
            after: {
              assignmentId: assignment.id,
              roleId: initialRole.id,
              roleSlug: initialRole.slug,
              scopeType: "global",
              scopeId: null,
              viaUserCreate: true,
            },
            request: getRequestContext(hdrs),
          },
          tx,
        );
      }

      return row;
    });

    return Response.json({ user: safeUser(created) }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.users.route.error");
  }
}

function safeUser(user: {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
  disabledAt: Date | null;
  mustChangePassword: boolean;
  passwordHash: string | null;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    lastLoginIp: user.lastLoginIp,
    disabledAt: user.disabledAt?.toISOString() ?? null,
    mustChangePassword: user.mustChangePassword,
    ssoOnly: user.passwordHash === null,
    createdAt: user.createdAt.toISOString(),
  };
}
