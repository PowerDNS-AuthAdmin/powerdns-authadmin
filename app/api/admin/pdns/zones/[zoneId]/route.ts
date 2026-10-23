/**
 * app/api/admin/pdns/zones/[zoneId]/route.ts
 *
 * DELETE - drop the zone on the PDNS backend entirely. Permission:
 *          `zone.delete` (type-level OR a per-zone grant).
 *
 * The web UI gates this behind a download-backup + type-to-confirm
 * flow; the API does NOT (per the user's call - programmatic clients
 * shouldn't be asked to type a phrase). The API still requires CSRF
 * + the right permission.
 *
 * One exception (#209): a catalog Producer zone with members answers 409
 * `catalog-has-members` unless `?confirmCatalog=<zone name>` is passed.
 * Deleting it silently stops every secondary reading the catalog from
 * following zone additions and removals, which no ordinary delete does.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { invalidateFleetScan } from "@/app/api/admin/pdns/auto-ptr/_scan";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { deleteZoneHorizon, horizonScopeFor } from "@/lib/db/repositories/zone-horizons";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canonicalZoneName } from "@/lib/dns/zone-name";
import { liveCatalogMembers } from "@/lib/pdns/catalog-members";
import { catalogRole } from "@/lib/pdns/zone-kinds";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "@/lib/errors";

const deleteQuerySchema = z.object({
  serverSlug: z.string().optional(),
  /** The zone's name, repeated: required to delete a catalog Producer zone that has members. */
  confirmCatalog: z.string().max(255).optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const auth = await requireUser();
    const { user: actor } = auth;
    await requireCsrf(request);

    const { zoneId } = await context.params;
    const url = new URL(request.url);
    let parsed;
    try {
      parsed = deleteQuerySchema.parse(Object.fromEntries(url.searchParams));
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
    }

    const selected = parsed.serverSlug
      ? await findPdnsServerBySlug(parsed.serverSlug)
      : await findDefaultPdnsServer();
    if (selected?.disabledAt !== null) {
      throw new NotFoundError("No PDNS backend selected.");
    }

    const client = getBackendGateway(selected);
    // Canonical form: grants are stored lowercase with the trailing dot, and
    // the audit resource id must not vary with the casing the URL carried.
    const zoneName = canonicalZoneName(decodeURIComponent(zoneId));

    if (!canActOnZone(auth, { serverId: selected.id, zoneName, permission: "zone.delete" })) {
      throw new ForbiddenError("Missing zone.delete for this zone.");
    }

    // Snapshot for the audit before-state. Capture the zone meta and
    // a record count - full rrsets are too large for the audit row and
    // the operator has the download for forensics anyway.
    const before = await client.getZone(zoneName).catch(() => null);

    let catalogMemberCount: number | null = null;
    if (before && catalogRole(before.kind) === "producer") {
      const live = await liveCatalogMembers(client, zoneName);
      catalogMemberCount = live.members.length;
      const confirmed =
        parsed.confirmCatalog !== undefined &&
        canonicalZoneName(parsed.confirmCatalog) === zoneName;
      // A zone that couldn't be read might be a member, so an incomplete count
      // needs the same confirmation as a non-zero one.
      if ((catalogMemberCount > 0 || !live.complete) && !confirmed) {
        const counted = live.complete
          ? `${catalogMemberCount} zone(s) name ${zoneName} as their catalog.`
          : `At least ${catalogMemberCount} zone(s) name ${zoneName} as their catalog; some zones couldn't be read.`;
        return Response.json(
          {
            error: "catalog-has-members",
            members: catalogMemberCount,
            complete: live.complete,
            detail: `${counted} Deleting it stops secondaries from learning about zone additions and removals. Pass confirmCatalog=${zoneName} to delete it anyway.`,
          },
          { status: 409 },
        );
      }
    }

    try {
      await client.deleteZone(zoneName);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError("Zone not found on backend.");
      }
      if (err instanceof PdnsError) {
        const message = redact(err.message);
        logger.warn({ err: message }, "pdns.zone.delete.failed");
        return Response.json({ error: `PDNS rejected the request: ${message}` }, { status: 502 });
      }
      throw err;
    }

    // Drop the horizon classification with the zone. Left behind, it would
    // silently re-apply to a zone of the same name recreated later on this
    // backend. Best-effort: the zone is already gone on PDNS, and a stale row
    // classifies nothing until such a recreate.
    try {
      await deleteZoneHorizon(horizonScopeFor(selected), zoneName);
    } catch (err) {
      logger.warn(
        {
          server: selected.slug,
          zone: zoneName,
          error: err instanceof Error ? redact(err.message) : "unknown",
        },
        "zone.delete.horizon-cleanup.failed",
      );
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "zone.delete",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: before
        ? {
            name: before.name,
            kind: before.kind,
            serial: before.serial,
            rrsetCount: (before.rrsets ?? []).length,
            ...(catalogMemberCount !== null ? { catalogMembers: catalogMemberCount } : {}),
          }
        : null,
      after: null,
      request: getRequestContext(hdrs),
    });

    publishZoneEvent({
      type: "zone.updated",
      zone: zoneName,
      serverSlug: selected.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    // Search, the record wizard and the reverse report read the fleet scan.
    invalidateFleetScan();
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
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "pdns.zone.delete.route.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
