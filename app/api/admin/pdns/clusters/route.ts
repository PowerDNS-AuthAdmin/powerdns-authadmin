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
import { assignServerToCluster, findPdnsServerById } from "@/lib/db/repositories/pdns-servers";
import { createClusterSchema } from "@/lib/validators/pdns-clusters";
import { ConflictError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { invalidateBackendObservation, scheduleImmediatePoll } from "@/lib/realtime/zone-poller";

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

    // Resolve any initial members up front so we can reject bad picks with a
    // clean field error instead of a half-created group. Each must exist and be
    // ungrouped — assigning a server already in a group would silently move it.
    const memberIds = [...new Set(input.memberServerIds ?? [])];
    const members = await Promise.all(memberIds.map((id) => findPdnsServerById(id)));
    const missing = memberIds.filter((_, i) => members[i] === null);
    const alreadyGrouped = members.filter((m) => m !== null && m.clusterId !== null);
    if (missing.length > 0 || alreadyGrouped.length > 0) {
      const problems: string[] = [];
      if (missing.length > 0) problems.push(`${missing.length} no longer exist`);
      if (alreadyGrouped.length > 0) {
        problems.push(`${alreadyGrouped.length} already belong to another group`);
      }
      throw new ValidationError("Invalid input.", {
        fieldErrors: {
          memberServerIds: [`Some selected servers can't be added: ${problems.join("; ")}.`],
        },
      });
    }
    const resolvedMembers = members.filter((m): m is NonNullable<typeof m> => m !== null);

    const hdrs = await headers();
    const requestCtx = getRequestContext(hdrs);
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
            members: resolvedMembers.map((m) => m.slug),
          },
          request: requestCtx,
        },
        tx,
      );

      // Assign the initial members in the same transaction; each is its own
      // server.update audit row so the membership change is traceable per server.
      for (const member of resolvedMembers) {
        await assignServerToCluster(member.id, created.id, tx);
        await appendAudit(
          {
            actor: { type: "user", id: user.id },
            action: "server.update",
            resource: { type: "pdns_server", id: member.id },
            before: { slug: member.slug, name: member.name, clusterId: null },
            after: { slug: member.slug, name: member.name, clusterId: created.id },
            request: requestCtx,
          },
          tx,
        );
      }

      return created;
    });

    // New group memberships shift the derived replication topology — re-derive
    // for the post-create render and schedule a poll for any other open views.
    if (resolvedMembers.length > 0) {
      invalidateBackendObservation();
      scheduleImmediatePoll();
    }

    return Response.json({ cluster: row }, { status: 201 });
  } catch (err) {
    return errorResponse(err, "admin.clusters.route.error");
  }
}
