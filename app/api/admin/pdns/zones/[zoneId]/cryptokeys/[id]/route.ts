/**
 * app/api/admin/pdns/zones/[zoneId]/cryptokeys/[id]/route.ts
 *
 * PUT    - toggle active / published flags on an existing cryptokey.
 *          Permission: `dnssec.configure` (with zone-grant fallback).
 * DELETE - permanently remove a cryptokey. Permission: same.
 *
 * Both routes pre-fetch the row via `getCryptokey` so the audit
 * snapshot captures meaningful before-state (id, keytype, active flag).
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
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { assertEditableZoneKind } from "@/lib/pdns/writable-kind";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

const putBodySchema = z.object({
  serverSlug: z.string().optional(),
  active: z.boolean().optional(),
  published: z.boolean().optional(),
});

const deleteQuerySchema = z.object({
  serverSlug: z.string().optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string; id: string }>;
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId, id: rawId } = await context.params;
    const zoneName = normalizeZoneId(decodeURIComponent(zoneId));
    const cryptokeyId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(cryptokeyId) || cryptokeyId < 0) {
      throw new ValidationError("Invalid cryptokey id.");
    }

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
    if (body.active === undefined && body.published === undefined) {
      throw new ValidationError("Set at least one of active or published.");
    }

    const selected = await resolveServer(body.serverSlug);
    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("dnssec.configure"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "dnssec.configure",
      })
    ) {
      throw new ForbiddenError("Missing dnssec.configure for this zone.");
    }

    const client = getBackendGateway(selected);
    // DNSSEC key state lives on the primary; a mirror serves presigned RRSIGs it
    // received over AXFR, so key management (toggle/delete) is read-only there -
    // gate by the zone's kind, same as create (ADR-0014).
    let zone;
    try {
      zone = await client.getZone(zoneName);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError(`Zone "${zoneName}" not found on backend.`);
      }
      throw err;
    }
    assertEditableZoneKind(zone.kind);
    let before;
    try {
      before = await client.getCryptokey(zoneName, cryptokeyId);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) throw new NotFoundError("Cryptokey not found.");
      throw err;
    }

    await client.updateCryptokey(zoneName, cryptokeyId, {
      ...(body.active !== undefined ? { active: body.active } : {}),
      ...(body.published !== undefined ? { published: body.published } : {}),
    });

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.cryptokey.update",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: { cryptokeyId: before.id, active: before.active, published: before.published },
      after: {
        cryptokeyId: before.id,
        active: body.active ?? before.active,
        published: body.published ?? before.published,
      },
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
    return errorResponse(err, "pdns.cryptokey.route.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId, id: rawId } = await context.params;
    const zoneName = normalizeZoneId(decodeURIComponent(zoneId));
    const cryptokeyId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(cryptokeyId) || cryptokeyId < 0) {
      throw new ValidationError("Invalid cryptokey id.");
    }

    const url = new URL(request.url);
    const { serverSlug } = deleteQuerySchema.parse(Object.fromEntries(url.searchParams));
    const selected = await resolveServer(serverSlug);
    if (
      !canActOnZone({
        hasGlobalPermission: globalPermissions.has("dnssec.configure"),
        grants: zoneGrants,
        serverId: selected.id,
        zoneName,
        permission: "dnssec.configure",
      })
    ) {
      throw new ForbiddenError("Missing dnssec.configure for this zone.");
    }

    const client = getBackendGateway(selected);
    // DNSSEC key state lives on the primary; a mirror serves presigned RRSIGs it
    // received over AXFR, so key management (toggle/delete) is read-only there -
    // gate by the zone's kind, same as create (ADR-0014).
    let zone;
    try {
      zone = await client.getZone(zoneName);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) {
        throw new NotFoundError(`Zone "${zoneName}" not found on backend.`);
      }
      throw err;
    }
    assertEditableZoneKind(zone.kind);
    let before;
    try {
      before = await client.getCryptokey(zoneName, cryptokeyId);
    } catch (err) {
      if (err instanceof PdnsNotFoundError) throw new NotFoundError("Cryptokey not found.");
      throw err;
    }

    await client.deleteCryptokey(zoneName, cryptokeyId);

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.cryptokey.delete",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      before: { cryptokeyId: before.id, keytype: before.keytype, active: before.active },
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
    scheduleImmediatePoll();

    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "pdns.cryptokey.route.error");
  }
}

async function resolveServer(slug: string | undefined) {
  const selected = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
  if (selected?.disabledAt !== null) {
    throw new NotFoundError("No PDNS backend selected.");
  }
  return selected;
}
