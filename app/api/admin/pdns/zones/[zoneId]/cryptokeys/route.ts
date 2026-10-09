/**
 * app/api/admin/pdns/zones/[zoneId]/cryptokeys/route.ts
 *
 * GET  - list the zone's cryptokeys with DNSKEY + DS (`?serverSlug=`).
 *        Permission: `dnssec.read`. Never returns private key material.
 *        Response: `{ cryptokeys: [...], ds: [...] }`, where `ds` is the set
 *        to publish at the parent (active, published KSK/CSK only).
 *
 * POST - generate a new DNSSEC cryptokey for the zone. Permission:
 *        `dnssec.configure` (type-level) OR a zone_grant with that
 *        permission. CSRF + audit. PDNS generates the key
 *        server-side; we never see the private material (same
 *        discipline as TSIG).
 *
 * Defaults - `keytype: "ksk"`, `active: true`. Operator can override
 * via the request body.
 *
 * PowerDNS doesn't rectify on `POST /cryptokeys`, so this route rectifies
 * afterwards (`rectified` in the response). It doesn't touch SOA-EDIT or the
 * serial - to sign an unsigned zone, prefer `POST .../dnssec`.
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
import { assertEditableZoneKind } from "@/lib/pdns/writable-kind";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { normalizeZoneId } from "@/lib/pdns/client";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { dsRecordsToPublish } from "@/lib/pdns/dnssec-plan";
import { loadDnssecZone, parseInput, publicKey } from "../_dnssec-context";

const KEYTYPES = ["ksk", "zsk", "csk"] as const;

const createSchema = z.object({
  serverSlug: z.string().optional(),
  keytype: z.enum(KEYTYPES).default("ksk"),
  active: z.boolean().default(true),
  published: z.boolean().optional(),
  algorithm: z.string().max(64).optional(),
  bits: z.number().int().positive().max(8192).optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

const listQuerySchema = z.object({ serverSlug: z.string().optional() });

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { zoneId } = await context.params;
    const query = parseInput(
      listQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const { server, client, zone } = await loadDnssecZone(
      zoneId,
      query.serverSlug,
      "dnssec.read",
      undefined,
      { rrsets: false },
    );
    const keys = await client.listCryptokeys(zone.name);
    return Response.json({
      zone: zone.name,
      serverSlug: server.slug,
      dnssec: zone.dnssec === true,
      cryptokeys: keys.map(publicKey),
      ds: dsRecordsToPublish(keys),
    });
  } catch (err) {
    return errorResponse(err, "pdns.cryptokey.list.error");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user: actor, globalPermissions, zoneGrants } = await requireUser();
    await requireCsrf(request);

    const { zoneId } = await context.params;
    const zoneName = normalizeZoneId(decodeURIComponent(zoneId));

    let body;
    try {
      body = createSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", {
          fieldErrors: err.flatten().fieldErrors,
        });
      }
      throw err;
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
    // DNSSEC keys live on the primary; a mirror serves presigned RRSIGs it got
    // over AXFR, so key management is read-only there - gate by the zone kind.
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
    const created = await client.createCryptokey(zoneName, {
      keytype: body.keytype,
      active: body.active,
      ...(body.published !== undefined ? { published: body.published } : {}),
      ...(body.algorithm !== undefined ? { algorithm: body.algorithm } : {}),
      ...(body.bits !== undefined ? { bits: body.bits } : {}),
    });
    // POST /cryptokeys doesn't rectify; without it a newly signed zone serves
    // broken NSEC/NSEC3 denial (NULL ordernames). Best-effort: the key exists
    // either way, and `rectified: false` tells the caller to retry via
    // PUT .../rectify.
    let rectified = false;
    try {
      await client.rectifyZone(zoneName);
      rectified = true;
    } catch (err) {
      logger.warn(
        {
          server: selected.slug,
          zone: zoneName,
          err: err instanceof Error ? redact(err.message) : "unknown",
        },
        "pdns.cryptokey.rectify.failed",
      );
    }

    const hdrs = await headers();
    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.cryptokey.create",
      resource: { type: "zone", id: `${selected.slug}:${zoneName}` },
      after: {
        cryptokeyId: created.id,
        keytype: created.keytype,
        active: created.active,
        algorithm: created.algorithm,
        bits: created.bits,
        rectified,
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

    return Response.json({ ok: true, cryptokey: created, rectified }, { status: 201 });
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
