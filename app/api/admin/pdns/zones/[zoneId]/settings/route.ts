/**
 * app/api/admin/pdns/zones/[zoneId]/settings/route.ts
 *
 * PUT - set zone-object fields PDNS exposes outside the `/metadata/{kind}`
 *       allowlist: kind (Native/Primary/Secondary), masters (for
 *       secondaries), soa_edit, soa_edit_api, api_rectify. Routed through
 *       `PUT /zones/{id}` so PDNS' direct-to-backend writer is used,
 *       sidestepping the metadata-endpoint allowlist that rejects
 *       SOA-EDIT, SOA-EDIT-API and API-RECTIFY on 4.9.
 *
 * Permission: `zone.update` (gated by the EITHER-OR pattern shared with the
 * metadata route - type-level role OR a per-zone grant).
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
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { PdnsError } from "@/lib/pdns/errors";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

const ZONE_KIND_VALUES = [
  "Native",
  "Master",
  "Slave",
  "Primary",
  "Secondary",
  "Producer",
  "Consumer",
] as const;

const putBodySchema = z.object({
  serverSlug: z.string().optional(),
  kind: z.enum(ZONE_KIND_VALUES).optional(),
  masters: z.array(z.string().max(255)).max(32).optional(),
  soa_edit: z.string().max(64).optional(),
  soa_edit_api: z.string().max(64).optional(),
  api_rectify: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId } = await context.params;

    let body;
    try {
      body = putBodySchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = body.serverSlug
      ? await findPdnsServerBySlug(body.serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    const client = getBackendGateway(selected);
    const zoneName = decodeURIComponent(zoneId);

    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("zone.update"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "zone.update",
      })
    ) {
      throw new ForbiddenError("Missing zone.update for this zone.");
    }

    // Read current state for the audit `before` snapshot.
    const before = await client.getZone(zoneName).catch(() => null);

    const patch: {
      kind?: (typeof ZONE_KIND_VALUES)[number];
      masters?: string[];
      soa_edit?: string;
      soa_edit_api?: string;
      api_rectify?: boolean;
    } = {};
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.masters !== undefined) patch.masters = [...body.masters];
    if (body.soa_edit !== undefined) patch.soa_edit = body.soa_edit;
    if (body.soa_edit_api !== undefined) patch.soa_edit_api = body.soa_edit_api;
    if (body.api_rectify !== undefined) patch.api_rectify = body.api_rectify;

    await client.updateZoneSettings(zoneName, patch);
    const after = await client.getZone(zoneName).catch(() => null);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.settings.update",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: before
        ? {
            kind: before.kind,
            masters: before.masters,
            soa_edit: before.soa_edit,
            soa_edit_api: before.soa_edit_api,
            api_rectify: before.api_rectify,
          }
        : null,
      after: after
        ? {
            kind: after.kind,
            masters: after.masters,
            soa_edit: after.soa_edit,
            soa_edit_api: after.soa_edit_api,
            api_rectify: after.api_rectify,
          }
        : null,
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: selected.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return Response.json({ error: err.message }, { status: 401 });
    }
    if (err instanceof ForbiddenError) {
      return Response.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof NotFoundError) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof ValidationError) {
      return Response.json({ error: err.message, details: err.details }, { status: 400 });
    }
    if (err instanceof PdnsError) {
      const message = redact(err.message);
      logger.warn({ err: message }, "pdns.zone.settings.failed");
      return Response.json({ error: `PDNS rejected the request: ${message}` }, { status: 502 });
    }
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "pdns.zone.settings.route.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
