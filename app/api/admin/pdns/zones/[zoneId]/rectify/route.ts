/**
 * app/api/admin/pdns/zones/[zoneId]/rectify/route.ts
 *
 * PUT - rectify the zone (`PUT /zones/{id}/rectify`): recompute ordername +
 *       auth for every record. Needed when keys were added through
 *       `/cryptokeys` (which doesn't rectify) or records were written outside
 *       the API. Body: `{ serverSlug?, bumpSerial? }`.
 *
 *       Rectifying doesn't change the serial, so secondaries that hold the
 *       zone presigned won't re-transfer the corrected NSEC chain on their
 *       own. `bumpSerial` (default: true when the zone is replicated) bumps
 *       the SOA serial and NOTIFYs.
 *
 * Permission: `dnssec.configure`. Mirror zones are refused (PowerDNS also
 * refuses presigned zones).
 */

import { headers } from "next/headers";
import { z } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { ensureServedSerialAdvanced, notifyIfTransferred } from "@/lib/pdns/dnssec-actions";
import { isTransferredKind } from "@/lib/pdns/dnssec-plan";
import { PdnsConflictError, PdnsUnprocessableError, PdnsValidationError } from "@/lib/pdns/errors";
import { servedSerialOfZone } from "@/lib/pdns/serial-sync";
import { zoneHasMirrors } from "@/lib/pdns/sync";
import { assertEditableZoneKind } from "@/lib/pdns/writable-kind";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { redact } from "@/lib/errors/redact";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { loadDnssecZone, parseInput, readJsonBody } from "../_dnssec-context";

const bodySchema = z.object({
  serverSlug: z.string().optional(),
  bumpSerial: z.boolean().optional(),
});

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { zoneId } = await context.params;
    const body = parseInput(bodySchema, await readJsonBody(request));
    const { actor, server, client, zone } = await loadDnssecZone(
      zoneId,
      body.serverSlug,
      "dnssec.configure",
      request,
      { rrsets: false },
    );
    assertEditableZoneKind(zone.kind);

    try {
      await client.rectifyZone(zone.name);
    } catch (err) {
      if (
        err instanceof PdnsValidationError ||
        err instanceof PdnsUnprocessableError ||
        err instanceof PdnsConflictError
      ) {
        throw new ValidationError(`PowerDNS refused: ${redact(err.message)}`);
      }
      throw err;
    }

    const replicated = isTransferredKind(zone.kind) || (await zoneHasMirrors(server, zone.name));
    const bump = body.bumpSerial ?? replicated;
    // Pass the CURRENT served serial so the helper always bumps: rectify
    // itself never moves it.
    const { zone: after, advance } = bump
      ? await ensureServedSerialAdvanced(client, zone.name, servedSerialOfZone(zone))
      : { zone, advance: "unchanged" as const };
    const notified = bump ? await notifyIfTransferred(client, after, server.slug) : false;

    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.rectify",
      resource: { type: "zone", id: `${server.slug}:${zone.name}` },
      before: { serial: zone.serial ?? null, edited_serial: zone.edited_serial ?? null },
      after: {
        serial: after.serial ?? null,
        edited_serial: after.edited_serial ?? null,
        serialAdvance: advance,
        notified,
      },
      request: getRequestContext(await headers()),
    });
    publishZoneEvent({
      type: "zone.updated",
      zone: zone.name,
      serverSlug: server.slug,
      actor: actor.email,
      at: new Date().toISOString(),
    });
    scheduleImmediatePoll();

    return Response.json({
      ok: true,
      zone: zone.name,
      serverSlug: server.slug,
      dnssec: after.dnssec === true,
      serialAdvance: advance,
      servedSerial: servedSerialOfZone(after),
      notified,
    });
  } catch (err) {
    return errorResponse(err, "pdns.zone.rectify.error");
  }
}
