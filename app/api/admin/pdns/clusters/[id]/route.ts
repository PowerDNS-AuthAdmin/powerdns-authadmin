/**
 * app/api/admin/pdns/clusters/[id]/route.ts
 *
 * GET    — cluster detail + members (server.read).
 * PATCH  — update name/description/writeStrategy (server.update).
 * DELETE — drop the cluster (server.delete). Peers in the cluster have
 *          their cluster_id NULLed by the FK ON DELETE SET NULL — they
 *          become standalone primaries.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  deleteCluster,
  findClusterById,
  listAllServersForCluster,
  updateCluster,
} from "@/lib/db/repositories/pdns-clusters";
import { updateClusterSchema } from "@/lib/validators/pdns-clusters";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_: Request, ctx: RouteContext): Promise<Response> {
  try {
    await requireUser({ can: "server.read" });
    const { id } = await ctx.params;
    const cluster = await findClusterById(id);
    if (!cluster) throw new NotFoundError("Cluster not found.");
    const members = await listAllServersForCluster(id);
    return Response.json({ cluster, members });
  } catch (err) {
    return errorResponse(err, "admin.clusters.id.route.error");
  }
}

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.update" });
    await requireCsrf(request);
    const { id } = await ctx.params;

    const existing = await findClusterById(id);
    if (!existing) throw new NotFoundError("Cluster not found.");

    let input;
    try {
      input = updateClusterSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const hdrs = await headers();
    const updated = await db.transaction(async (tx) => {
      const row = await updateCluster(
        id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.writeStrategy !== undefined ? { writeStrategy: input.writeStrategy } : {}),
        },
        tx,
      );
      if (!row) throw new NotFoundError("Cluster not found.");

      const before = {
        name: existing.name,
        description: existing.description,
        writeStrategy: existing.writeStrategy,
      };
      const after = {
        name: row.name,
        description: row.description,
        writeStrategy: row.writeStrategy,
      };
      const changed = (Object.keys(before) as Array<keyof typeof before>).some(
        (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
      );
      if (changed) {
        await appendAudit(
          {
            actor: { type: "user", id: user.id },
            action: "cluster.update",
            resource: { type: "cluster", id },
            before,
            after,
            request: getRequestContext(hdrs),
          },
          tx,
        );
      }

      return row;
    });

    return Response.json({ cluster: updated });
  } catch (err) {
    return errorResponse(err, "admin.clusters.id.route.error");
  }
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.delete" });
    await requireCsrf(request);
    const { id } = await ctx.params;

    const existing = await findClusterById(id);
    if (!existing) throw new NotFoundError("Cluster not found.");

    const hdrs = await headers();
    await db.transaction(async (tx) => {
      await deleteCluster(id, tx);

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "cluster.delete",
          resource: { type: "cluster", id },
          before: {
            slug: existing.slug,
            name: existing.name,
            description: existing.description,
            writeStrategy: existing.writeStrategy,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );
    });

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "admin.clusters.id.route.error");
  }
}
