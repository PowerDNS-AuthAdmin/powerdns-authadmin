/**
 * app/api/admin/pdns/clusters/route.ts
 *
 * GET  — list every cluster (server.read).
 * POST — create a cluster (server.create). Slug collisions return 409.
 */

import { headers } from "next/headers";
import { ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { db } from "@/lib/db";
import {
  findClusterBySlug,
  insertCluster,
  listAllClusters,
} from "@/lib/db/repositories/pdns-clusters";
import { createClusterSchema } from "@/lib/validators/pdns-clusters";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "server.read" });
    const rows = await listAllClusters();
    return Response.json({ clusters: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "admin.clusters.route.error");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.create" });
    await requireCsrf(request);

    let input;
    try {
      input = createClusterSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    if (await findClusterBySlug(input.slug)) {
      throw new ConflictError(`A cluster with slug "${input.slug}" already exists.`);
    }

    const hdrs = await headers();
    const row = await db.transaction(async (tx) => {
      const created = await insertCluster(
        {
          slug: input.slug,
          name: input.name,
          description: input.description ?? null,
          writeStrategy: input.writeStrategy,
          createdBy: user.id,
        },
        tx,
      );

      await appendAudit(
        {
          actor: { type: "user", id: user.id },
          action: "cluster.create",
          resource: { type: "cluster", id: created.id },
          after: {
            slug: created.slug,
            name: created.name,
            description: created.description,
            writeStrategy: created.writeStrategy,
          },
          request: getRequestContext(hdrs),
        },
        tx,
      );

      return created;
    });

    return Response.json({ cluster: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.clusters.route.error");
  }
}
