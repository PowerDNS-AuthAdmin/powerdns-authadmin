/**
 * Shared preamble for the zone-level DNSSEC routes (dnssec, rectify, and the
 * cryptokeys GET): resolve the backend (`serverSlug`, else the default),
 * enforce the per-zone permission (global OR zone grant), and load the zone.
 */

import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { normalizeZoneId } from "@/lib/pdns/client";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import type { PdnsClient } from "@/lib/pdns/client";
import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsCryptokeySummary, PdnsZoneDetail } from "@/lib/pdns/types";
import type { ZodType } from "zod";
import { ZodError } from "zod";

export interface DnssecRouteContext {
  actor: Awaited<ReturnType<typeof requireUser>>["user"];
  server: PdnsServer;
  client: PdnsClient;
  zoneName: string;
  zone: PdnsZoneDetail;
}

/**
 * Pass `csrfRequest` on mutating routes: the CSRF check runs straight after
 * authentication, before anything touches PowerDNS.
 *
 * `rrsets: false` skips the record sets on the zone GET. Only the status
 * body and the enable plan look at them (the LUA/ALIAS warnings); disable,
 * rectify and the key listing don't, and a large zone pays a full transfer
 * for every one of those calls otherwise.
 */
export async function loadDnssecZone(
  rawZoneId: string,
  serverSlug: string | undefined,
  permission: "dnssec.read" | "dnssec.configure",
  csrfRequest?: Request,
  opts: { rrsets?: boolean } = {},
): Promise<DnssecRouteContext> {
  const { user: actor, globalPermissions, zoneGrants } = await requireUser();
  if (csrfRequest) await requireCsrf(csrfRequest);
  const zoneName = normalizeZoneId(decodeURIComponent(rawZoneId));

  const server = serverSlug
    ? await findPdnsServerBySlug(serverSlug)
    : await findDefaultPdnsServer();
  if (server?.disabledAt !== null) {
    throw new NotFoundError(
      serverSlug
        ? `No active PDNS backend "${serverSlug}".`
        : "No default PDNS backend - pass serverSlug.",
    );
  }
  if (
    !canActOnZone({
      hasGlobalPermission: globalPermissions.has(permission),
      grants: zoneGrants,
      serverId: server.id,
      zoneName,
      permission,
    })
  ) {
    throw new ForbiddenError(`Missing ${permission} for this zone.`);
  }

  const client = getBackendGateway(server);
  let zone: PdnsZoneDetail;
  try {
    zone = await client.getZone(zoneName, opts.rrsets === false ? { rrsets: false } : undefined);
  } catch (err) {
    if (err instanceof PdnsNotFoundError) {
      throw new NotFoundError(`Zone "${zoneName}" not found on backend.`);
    }
    throw err;
  }
  return { actor, server, client, zoneName, zone };
}

/** Parse a body/query with a Zod schema, mapping failures to a 400. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
    }
    throw err;
  }
}

/** Request body as JSON; an empty body reads as `{}`. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ValidationError("Request body is not valid JSON.");
  }
}

/** The key fields an API client needs - never `privatekey` (the schema drops it anyway). */
export function publicKey(k: PdnsCryptokeySummary) {
  return {
    id: k.id,
    keytype: k.keytype,
    active: k.active,
    published: k.published ?? null,
    flags: k.flags ?? null,
    algorithm: k.algorithm ?? null,
    bits: k.bits ?? null,
    dnskey: k.dnskey,
    ds: k.ds ?? [],
    cds: k.cds ?? [],
  };
}
