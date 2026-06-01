/**
 * app/api/admin/pdns/zones/[zoneId]/tsig-transfer/route.ts
 *
 * POST - set (or clear) the TSIG key that secures this zone's AXFR. One call
 *        wires BOTH ends: TSIG-ALLOW-AXFR on the primary's copy of the zone and
 *        AXFR-MASTER-TSIG on each secondary that hosts it. `serverSlug` is the
 *        primary; `keyName` is the key (null clears).
 *
 * This is zone metadata, so it's gated on `metadata.write` (type-level OR a
 * per-zone grant), exactly like the raw metadata route - replicating to the
 * secondaries is a convenience on top, not a privilege escalation.
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
import { setZoneTransferKey } from "@/lib/realtime/tsig-replication";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const bodySchema = z.object({
  serverSlug: z.string().optional(),
  // The TSIG key to add/remove for this zone's AXFR.
  keyName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9.-]+$/, "Invalid key name."),
  // Additive by design - `add` unions the key in, `remove` takes only it out,
  // so other keys configured on the zone are never clobbered.
  mode: z.enum(["add", "remove"]),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId } = await context.params;
    const zoneName = decodeURIComponent(zoneId);

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const primary = body.serverSlug
      ? await findPdnsServerBySlug(body.serverSlug)
      : await findDefaultPdnsServer();
    if (primary?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("metadata.write"),
        grants: zoneGrants,
        serverId: primary.id,
        zoneName,
        permission: "metadata.write",
      })
    ) {
      throw new ForbiddenError("Missing metadata.write for this zone.");
    }

    const result = await setZoneTransferKey(primary, zoneName, body.keyName, body.mode);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.tsig-transfer.set",
      resource: { type: "zone", id: `${primary.slug}:${zoneName}` },
      after: {
        keyName: body.keyName,
        mode: body.mode,
        primaryOk: result.primaryOk,
        secondaries: result.secondaries.map((s) => ({
          server: s.serverSlug,
          hosted: s.hosted,
          ok: s.ok,
        })),
      },
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: primary.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "pdns.tsig.zone-transfer.error");
  }
}
