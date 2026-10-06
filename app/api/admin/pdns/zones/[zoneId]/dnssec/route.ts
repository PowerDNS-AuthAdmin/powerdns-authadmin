/**
 * app/api/admin/pdns/zones/[zoneId]/dnssec/route.ts
 *
 * Zone-level DNSSEC state. All three accept `serverSlug` (body for POST,
 * query for GET/DELETE) and fall back to the default backend.
 *
 * GET    - signing state + keys + the DS set to publish at the parent, and
 *          each managed mirror's sync state. Permission: `dnssec.read`.
 * POST   - enable DNSSEC: `PUT /zones/{id}` with `dnssec: true`, which adds
 *          PowerDNS' default keys, rectifies and bumps the serial in one go
 *          (see lib/pdns/dnssec-plan.ts for why not `/cryptokeys`). Also sets
 *          API-RECTIFY and, for a transferred zone without one, SOA-EDIT
 *          INCREMENT-WEEKS; then makes sure the served serial moved and
 *          NOTIFYs. Idempotent: an already-signed zone gets the settings,
 *          a rectify and the NOTIFY. Permission: `dnssec.configure`.
 * DELETE - disable DNSSEC (removes every key). Requires `confirm=<zone>` -
 *          remove the DS at the registrar and wait out its TTL first, or
 *          validating resolvers will SERVFAIL the zone.
 *          Permission: `dnssec.configure`.
 *
 * Read-only mirror zones (Slave/Secondary/Consumer) are refused: their
 * DNSSEC comes from the primary over AXFR.
 */

import { headers } from "next/headers";
import { z } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { ensureServedSerialAdvanced, notifyIfTransferred } from "@/lib/pdns/dnssec-actions";
import {
  dsRecordsToPublish,
  planDnssecEnable,
  sameZoneName,
  signedZoneWarnings,
  isTransferredKind,
} from "@/lib/pdns/dnssec-plan";
import { PdnsConflictError, PdnsUnprocessableError, PdnsValidationError } from "@/lib/pdns/errors";
import { servedSerialOfZone } from "@/lib/pdns/serial-sync";
import { checkZoneSync, zoneHasMirrors } from "@/lib/pdns/sync";
import { assertEditableZoneKind } from "@/lib/pdns/writable-kind";
import { publishZoneEvent } from "@/lib/realtime/event-bus";
import { scheduleImmediatePoll } from "@/lib/realtime/zone-poller";
import { redact } from "@/lib/errors/redact";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { loadDnssecZone, parseInput, publicKey, readJsonBody } from "../_dnssec-context";
import type { PdnsCryptokeySummary, PdnsZoneDetail } from "@/lib/pdns/types";

// SOA-EDIT kinds PowerDNS knows (pdns/serialtweaker.cc). "" clears it.
const SOA_EDIT_KINDS = [
  "",
  "INCREMENT-WEEKS",
  "INCEPTION-EPOCH",
  "INCEPTION-INCREMENT",
  "EPOCH",
  "NONE",
] as const;

const enableSchema = z.object({
  serverSlug: z.string().optional(),
  soaEdit: z.enum(SOA_EDIT_KINDS).optional(),
  apiRectify: z.boolean().optional(),
  nsec3param: z
    .string()
    .max(300)
    .regex(/^(|\d+ \d+ \d+ (-|[0-9a-fA-F]+))$/, 'Expected "<alg> <flags> <iterations> <salt|->".')
    .optional(),
  nsec3narrow: z.boolean().optional(),
  /** NOTIFY the zone's secondaries afterwards (Master/Primary zones). */
  notify: z.boolean().default(true),
});

const querySchema = z.object({ serverSlug: z.string().optional() });
const deleteQuerySchema = querySchema.extend({ confirm: z.string().optional() });

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { zoneId } = await context.params;
    const query = parseInput(querySchema, Object.fromEntries(new URL(request.url).searchParams));
    const { server, client, zone } = await loadDnssecZone(zoneId, query.serverSlug, "dnssec.read");
    const [keys, mirrors] = await Promise.all([
      zone.dnssec ? client.listCryptokeys(zone.name) : Promise.resolve([]),
      checkZoneSync(server, zone),
    ]);
    return Response.json({
      ...statusBody(server.slug, zone, keys, mirrors.length > 0),
      // Read from the poller's zone-state cache, like the zone page: with
      // PDNS_BACKGROUND_POLLING off it can be stale or report "missing".
      mirrors: mirrors.map((m) => ({
        serverSlug: m.server.slug,
        state: m.state,
        servedSerial: m.primarySerial,
        mirrorSerial: m.secondarySerial,
      })),
    });
  } catch (err) {
    return errorResponse(err, "pdns.dnssec.route.error");
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { zoneId } = await context.params;
    const body = parseInput(enableSchema, await readJsonBody(request));
    const { actor, server, client, zone } = await loadDnssecZone(
      zoneId,
      body.serverSlug,
      "dnssec.configure",
      request,
    );
    assertEditableZoneKind(zone.kind);

    const hasMirrors = await zoneHasMirrors(server, zone.name);
    const plan = planDnssecEnable(zone, hasMirrors, body);
    const wasSigned = zone.dnssec === true;
    const before = settingsSnapshot(zone);
    const servedBefore = servedSerialOfZone(zone);

    await withPdnsMessage(() => client.updateZoneSettings(zone.name, plan.settings));
    // The PUT only rectifies when it changes the signing state AND API-RECTIFY
    // is on. Rectify explicitly otherwise - an already-signed zone (the repair
    // path for keys added via /cryptokeys) or API-RECTIFY turned off.
    if (wasSigned || !plan.settings.api_rectify) {
      await withPdnsMessage(() => client.rectifyZone(zone.name));
    }

    const { zone: after, advance } = plan.replicated
      ? await ensureServedSerialAdvanced(client, zone.name, servedBefore)
      : { zone: await client.getZone(zone.name), advance: "unchanged" as const };
    const notified =
      body.notify && plan.replicated
        ? await notifyIfTransferred(client, after, server.slug)
        : false;
    const keys = await client.listCryptokeys(zone.name);

    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.enable",
      resource: { type: "zone", id: `${server.slug}:${zone.name}` },
      before,
      after: {
        ...settingsSnapshot(after),
        keys: keys.map((k) => ({ cryptokeyId: k.id, keytype: k.keytype, algorithm: k.algorithm })),
        serialAdvance: advance,
        notified,
      },
      request: getRequestContext(await headers()),
    });
    announce(server.slug, zone.name, actor.email);

    return Response.json(
      {
        ...statusBody(server.slug, after, keys, hasMirrors),
        alreadyEnabled: wasSigned,
        serialAdvance: advance,
        notified,
        warnings: plan.warnings,
      },
      { status: wasSigned ? 200 : 201 },
    );
  } catch (err) {
    return errorResponse(err, "pdns.dnssec.enable.error");
  }
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { zoneId } = await context.params;
    const query = parseInput(
      deleteQuerySchema,
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const { actor, server, client, zone } = await loadDnssecZone(
      zoneId,
      query.serverSlug,
      "dnssec.configure",
      request,
    );
    assertEditableZoneKind(zone.kind);
    if (!query.confirm || !sameZoneName(query.confirm, zone.name)) {
      throw new ValidationError(
        `Disabling DNSSEC needs confirm=${zone.name}. Remove the DS records at the registrar and wait out their TTL first - with a DS still published, validating resolvers fail the zone once it's unsigned.`,
      );
    }
    if (zone.dnssec !== true) {
      return Response.json({ ...statusBody(server.slug, zone, [], false), alreadyDisabled: true });
    }

    const keysBefore = await client.listCryptokeys(zone.name);
    const servedBefore = servedSerialOfZone(zone);
    // SOA-EDIT is left in place on purpose: removing it would drop the served
    // serial below what the secondaries hold, and they never transfer a lower
    // serial - they'd keep serving the signed copy.
    await withPdnsMessage(() => client.updateZoneSettings(zone.name, { dnssec: false }));

    const replicated = isTransferredKind(zone.kind) || (await zoneHasMirrors(server, zone.name));
    const { zone: after, advance } = replicated
      ? await ensureServedSerialAdvanced(client, zone.name, servedBefore)
      : { zone: await client.getZone(zone.name), advance: "unchanged" as const };
    const notified = replicated ? await notifyIfTransferred(client, after, server.slug) : false;

    await appendAudit({
      actor: { type: "user", id: actor.id },
      action: "dnssec.disable",
      resource: { type: "zone", id: `${server.slug}:${zone.name}` },
      before: {
        ...settingsSnapshot(zone),
        keys: keysBefore.map((k) => ({
          cryptokeyId: k.id,
          keytype: k.keytype,
          algorithm: k.algorithm,
        })),
      },
      after: { ...settingsSnapshot(after), serialAdvance: advance, notified },
      request: getRequestContext(await headers()),
    });
    announce(server.slug, zone.name, actor.email);

    return Response.json({
      ...statusBody(server.slug, after, [], false),
      alreadyDisabled: false,
      serialAdvance: advance,
      notified,
    });
  } catch (err) {
    return errorResponse(err, "pdns.dnssec.disable.error");
  }
}

function statusBody(
  serverSlug: string,
  zone: PdnsZoneDetail,
  keys: readonly PdnsCryptokeySummary[],
  hasMirrors: boolean,
) {
  const replicated = hasMirrors || isTransferredKind(zone.kind);
  return {
    zone: zone.name,
    serverSlug,
    kind: zone.kind,
    dnssec: zone.dnssec === true,
    nsec3param: zone.nsec3param ?? "",
    nsec3narrow: zone.nsec3narrow ?? false,
    soaEdit: zone.soa_edit ?? "",
    soaEditApi: zone.soa_edit_api ?? "",
    apiRectify: zone.api_rectify ?? null,
    serial: zone.serial ?? null,
    servedSerial: servedSerialOfZone(zone),
    hasMirrors,
    cryptokeys: keys.map(publicKey),
    ds: dsRecordsToPublish(keys),
    warnings: zone.dnssec ? signedZoneWarnings(zone, replicated) : [],
  };
}

function settingsSnapshot(zone: PdnsZoneDetail) {
  return {
    dnssec: zone.dnssec === true,
    nsec3param: zone.nsec3param ?? "",
    soa_edit: zone.soa_edit ?? "",
    api_rectify: zone.api_rectify ?? null,
    serial: zone.serial ?? null,
    edited_serial: zone.edited_serial ?? null,
  };
}

function announce(serverSlug: string, zoneName: string, actorEmail: string): void {
  publishZoneEvent({
    type: "zone.updated",
    zone: zoneName,
    serverSlug,
    actor: actorEmail,
    at: new Date().toISOString(),
  });
  scheduleImmediatePoll();
}

/**
 * PowerDNS' own message is the useful part when it refuses a DNSSEC change
 * ("No backend was able to secure…", "zone is pre-signed…"), so surface it
 * as a 400 rather than the generic 502.
 */
async function withPdnsMessage<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
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
}
