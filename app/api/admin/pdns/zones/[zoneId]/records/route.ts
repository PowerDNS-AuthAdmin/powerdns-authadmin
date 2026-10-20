/**
 * app/api/admin/pdns/zones/[zoneId]/records/route.ts
 *
 * GET ?serverSlug=&name=&type= - the RRsets at one owner name (optionally one
 * type), for "does this record already exist" checks in the Add record wizard
 * and MCP. Uses PowerDNS's filtered zone GET when the daemon has it, so a
 * lookup on a large zone does not transfer the whole zone.
 * Permission: `zone.read` and `record.read` on the zone.
 */

import { requireUser } from "@/lib/auth/require-user";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { redact } from "@/lib/errors/redact";
import { errorResponse } from "@/lib/http/error-response";
import { normalizeZoneId } from "@/lib/pdns/client";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { normalizeName, readComments } from "../rrsets/_shared";

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { globalPermissions, zoneGrants } = await requireUser();
    const { zoneId } = await context.params;
    const zone = normalizeZoneId(decodeURIComponent(zoneId));
    const url = new URL(request.url);
    const rawName = url.searchParams.get("name") ?? "@";
    if (!/^[A-Za-z0-9._\-*/@]{1,255}$/.test(rawName)) throw new ValidationError("Invalid name.");
    const type = (url.searchParams.get("type") ?? "").toUpperCase();
    if (type && !/^[A-Z0-9]{1,12}$/.test(type)) throw new ValidationError("Invalid type.");
    const slug = url.searchParams.get("serverSlug");
    const server = slug ? await findPdnsServerBySlug(slug) : await findDefaultPdnsServer();
    if (server?.disabledAt !== null)
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    const can = (permission: string): boolean =>
      canActOnZone({
        hasGlobalPermission: globalPermissions.has(permission),
        grants: zoneGrants,
        serverId: server.id,
        zoneName: zone,
        permission,
      });
    if (!can("zone.read") || !can("record.read"))
      throw new ForbiddenError("Missing zone.read / record.read for this zone.");

    const name = normalizeName(rawName, zone);
    const client = getBackendGateway(server);
    let rrsets;
    try {
      const detail = client.supports("supportsRrsetFilter")
        ? await client.getZone(zone, { rrsetName: name, ...(type ? { rrsetType: type } : {}) })
        : await client.getZone(zone);
      rrsets = (detail.rrsets ?? []).filter(
        (rr) => rr.name.toLowerCase() === name && (!type || rr.type === type),
      );
    } catch (err) {
      if (err instanceof PdnsNotFoundError)
        throw new NotFoundError(`Zone "${zone}" not found on backend.`);
      if (err instanceof PdnsError) throw new ValidationError(`PDNS: ${redact(err.message)}`);
      throw err;
    }
    return Response.json({
      zone,
      name,
      exists: rrsets.length > 0,
      rrsets: rrsets.map((rr) => ({
        name: rr.name,
        type: rr.type,
        ttl: rr.ttl,
        records: rr.records,
        comment: readComments(rr)
          .map((c) => (typeof c["content"] === "string" ? c["content"] : ""))
          .filter(Boolean)
          .join("\n"),
      })),
    });
  } catch (err) {
    return errorResponse(err, "zones.records.error");
  }
}
