/**
 * app/api/admin/pdns/zones/clone/route.ts
 *
 * POST — clone an existing zone into a new zone name. Implementation
 * is fetch source → rewrite rrset names → POST as a new zone. PDNS
 * has no native clone endpoint; this route packages the two-step
 * sequence into a single audited operation so reviewers see one
 * `zone.create` row with a `cloneSourceZone` field rather than
 * having to correlate two unrelated requests.
 *
 * Permission: `zone.create`.
 *
 * The source's SOA is dropped (PDNS regenerates one on create with
 * sensible defaults). The kind of the new zone matches the source —
 * cloning a Slave into a Master would be a weirder operation than a
 * clone, surfaced as a separate feature if anyone asks.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { normalizeZoneId } from "@/lib/pdns/client";
import { rewriteRRsetsForClone } from "@/lib/pdns/clone";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { createZoneAndNotify } from "@/lib/pdns/operations";
import { PdnsConflictError } from "@/lib/pdns/errors";
import { errorResponse } from "@/lib/http/error-response";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

const KIND_VALUES = ["Native", "Master", "Primary", "Slave", "Secondary"] as const;
type CloneableKind = (typeof KIND_VALUES)[number];

const cloneSchema = z.object({
  serverSlug: z.string().optional(),
  sourceName: z.string().min(1).max(255),
  targetName: z
    .string()
    .min(1)
    .max(255)
    .regex(
      /^[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?(?:\.[A-Za-z0-9_*]([A-Za-z0-9_*-]{0,62}[A-Za-z0-9_*])?)*\.?$/,
      "Target name has invalid label characters.",
    ),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user: actor } = await requireUser({ can: "zone.create" });
    await requireCsrf(request);

    let input;
    try {
      input = cloneSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const source = normalizeZoneId(input.sourceName);
    const target = normalizeZoneId(input.targetName);
    if (source === target) {
      throw new ValidationError("Target name must differ from source.");
    }

    const selected = input.serverSlug
      ? await findPdnsServerBySlug(input.serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }
    const client = getBackendGateway(selected);

    const sourceZone = await client.getZone(source);
    if (!isCloneableKind(sourceZone.kind)) {
      throw new ValidationError(`Cannot clone a zone of kind "${sourceZone.kind}".`);
    }

    const rewrittenRRsets = rewriteRRsetsForClone(sourceZone.rrsets ?? [], source, target);

    let created;
    try {
      created = await createZoneAndNotify(client, {
        name: target,
        kind: sourceZone.kind,
        rrsets: rewrittenRRsets.map((r) => ({
          name: r.name,
          type: r.type,
          ttl: r.ttl,
          changetype: "REPLACE",
          records: r.records,
        })),
      });
    } catch (err) {
      if (err instanceof PdnsConflictError) {
        throw new ConflictError("A zone with that name already exists.");
      }
      throw err;
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.create",
      resource: { type: "zone", id: target },
      after: {
        name: target,
        kind: created.kind,
        cloneSourceZone: source,
        rrsetCount: rewrittenRRsets.length,
      },
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: target,
      serverSlug: selected.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json(
      {
        ok: true,
        zone: { name: target, kind: created.kind },
        nextUrl: `/zones/${encodeURIComponent(target)}?server=${encodeURIComponent(selected.slug)}`,
      },
      { status: 201 },
    );
  } catch (err) {
    return errorResponse(err, "pdns.zone.clone.route.error");
  }
}

function isCloneableKind(kind: string): kind is CloneableKind {
  return (KIND_VALUES as readonly string[]).includes(kind);
}
