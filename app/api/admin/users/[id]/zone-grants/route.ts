/**
 * app/api/admin/users/[id]/zone-grants/route.ts
 *
 * POST — issue a zone grant to the user. Permission: `user.update`
 *        (managing a user's authorization surface is part of
 *        user-management; we don't need a separate `zone.grant.*`
 *        permission because the operator who can edit the user can
 *        already grant them whatever permissions they have themselves).
 * GET  — list the user's grants for the admin UI.
 *
 * Grant tuple is `(user, server, zone, permissions[])` keyed by the
 * unique index on (user, server, zone). A second POST with the same
 * tuple returns 409 — the operator can either DELETE then POST, or
 * use the (future) edit affordance once it lands.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import { zoneGrants } from "@/lib/db/schema";
import { findGrant, listGrantsForUser } from "@/lib/db/repositories/zone-grants";
import { findPdnsServerById } from "@/lib/db/repositories/pdns-servers";
import { findUserById } from "@/lib/db/repositories/users";
import { PERMISSIONS } from "@/lib/rbac/permissions";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const PERMISSION_SET = new Set<string>(PERMISSIONS);

const createSchema = z.object({
  serverId: z.string().uuid(),
  /** Operator types either form; the route canonicalizes to lowercase + trailing dot. */
  zoneName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._-]+$/, "Invalid zone name."),
  /** Subset of the master permission vocabulary. Empty list is a valid placeholder. */
  permissions: z
    .array(z.string())
    .max(64)
    .refine(
      (list) => list.every((p) => PERMISSION_SET.has(p)),
      "Permissions list contains values outside the master vocabulary.",
    ),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireUser({ can: "user.read" });
    const { id } = await context.params;
    const target = await findUserById(id);
    if (!target) throw new NotFoundError("User not found.");
    const grants = await listGrantsForUser(id);
    return Response.json({ grants });
  } catch (err) {
    return errorResponse(err, "admin.zone-grants.route.error");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "user.update" });
    await requireCsrf(request);
    const { id: targetUserId } = await context.params;

    const target = await findUserById(targetUserId);
    if (!target) throw new NotFoundError("User not found.");

    let input;
    try {
      input = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    // Canonicalize zone name.
    const zoneName = canonicalizeZoneName(input.zoneName);

    // Verify the referenced server exists and isn't disabled.
    const server = await findPdnsServerById(input.serverId);
    if (!server || server.disabledAt) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    // Refuse duplicate via the unique index — explicit check for a
    // friendlier error than the raw Postgres constraint violation.
    const existing = await findGrant({
      userId: targetUserId,
      serverId: input.serverId,
      zoneName,
    });
    if (existing) {
      throw new ConflictError(
        "User already has a grant for that (server, zone). Delete the existing grant first.",
      );
    }

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(zoneGrants)
        .values({
          userId: targetUserId,
          serverId: input.serverId,
          zoneName,
          permissions: input.permissions,
          createdBy: actor.id,
        })
        .returning();
      if (!inserted) throw new Error("Insert returned no row.");

      await appendAudit(
        {
          actor: { type: "user", id: actor.id },
          action: "zone.grant.create",
          resource: { type: "zone-grant", id: inserted.id },
          after: {
            userId: targetUserId,
            serverId: input.serverId,
            zoneName,
            permissions: input.permissions,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return inserted;
    });

    return Response.json({ ok: true, grant: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.zone-grants.route.error");
  }
}

function canonicalizeZoneName(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".") ? lower : `${lower}.`;
}
