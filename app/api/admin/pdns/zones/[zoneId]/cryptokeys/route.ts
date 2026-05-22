/**
 * app/api/admin/pdns/zones/[zoneId]/cryptokeys/route.ts
 *
 * POST — generate a new DNSSEC cryptokey for the zone. Permission:
 *        `dnssec.configure` (type-level) OR a zone_grant with that
 *        permission. CSRF + audit. PDNS generates the key
 *        server-side; we never see the private material (same
 *        discipline as TSIG).
 *
 * Defaults — `keytype: "ksk"`, `active: true`. Operator can override
 * via the request body.
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
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

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

    const client = getPdnsClientForRow(selected);
    const created = await client.createCryptokey(zoneName, {
      keytype: body.keytype,
      active: body.active,
      ...(body.published !== undefined ? { published: body.published } : {}),
      ...(body.algorithm !== undefined ? { algorithm: body.algorithm } : {}),
      ...(body.bits !== undefined ? { bits: body.bits } : {}),
    });

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

    return Response.json({ ok: true, cryptokey: created }, { status: 201 });
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
