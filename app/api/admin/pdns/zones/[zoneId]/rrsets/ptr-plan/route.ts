/**
 * app/api/admin/pdns/zones/[zoneId]/rrsets/ptr-plan/route.ts
 *
 * POST - dry run of the automatic PTR maintenance for a batch of RRset
 * changes, so the editor's Review step can show what the save would do to the
 * reverse zones BEFORE anything is written: which addresses get a PTR, in
 * which hosted zone, which are skipped (no reverse zone, no permission) and
 * which collide with a PTR that points at another name.
 *
 * Takes the same body as the PATCH, and is gated the same way: the caller must
 * be allowed to make the forward change, and reverse-zone permissions are
 * evaluated per address exactly as the real run does. Nothing is written and
 * nothing is audited. No CSRF exemption: it is a mutating-shaped request from
 * the app's own editor.
 */

import { ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findDefaultPdnsServer, findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { isAddressType, type AutoPtrOutcome } from "@/lib/dns/auto-ptr";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { redact } from "@/lib/errors/redact";
import { errorResponse } from "@/lib/http/error-response";
import { normalizeZoneId } from "@/lib/pdns/client";
import { PdnsError, PdnsNotFoundError } from "@/lib/pdns/errors";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { canActOnZone } from "@/lib/rbac/zone-permissions";
import { patchRRsetsSchema } from "@/lib/validators/rrsets";
import { resolveZoneAutoPtr, runAutoPtr, type AutoPtrChange } from "../_auto-ptr";
import { dedupeRecordsByContent, loadZoneBefore, normalizeName } from "../_shared";

interface RouteContext {
  params: Promise<{ zoneId: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const auth = await requireUser();
    const { user } = auth;
    await requireCsrf(request);
    const { zoneId: zoneParam } = await context.params;
    const zoneName = normalizeZoneId(decodeURIComponent(zoneParam));

    let input;
    try {
      input = patchRRsetsSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const server = input.serverSlug
      ? await findPdnsServerBySlug(input.serverSlug)
      : await findDefaultPdnsServer();
    if (server?.disabledAt !== null) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    const canOnZone = (serverId: string, zone: string, permission: string): boolean =>
      canActOnZone(auth, { serverId, zoneName: zone, permission });

    // Same gate as the PATCH: you may only plan what you could apply.
    const addressChanges = input.changes.filter((c) => isAddressType(c.type));
    if (addressChanges.some((c) => c.kind === "upsert")) {
      if (
        !canOnZone(server.id, zoneName, "record.create") &&
        !canOnZone(server.id, zoneName, "record.update")
      ) {
        throw new ForbiddenError("Missing record.create or record.update.");
      }
    }
    if (
      addressChanges.some((c) => c.kind === "delete") &&
      !canOnZone(server.id, zoneName, "record.delete")
    ) {
      throw new ForbiddenError("Missing record.delete.");
    }

    const client = getBackendGateway(server);
    const zoneDefault = await resolveZoneAutoPtr(client, zoneName);
    let ptr: AutoPtrOutcome[] = [];
    const enabledChanges: AutoPtrChange[] = [];
    if (addressChanges.length > 0) {
      let zoneBefore;
      try {
        zoneBefore = await loadZoneBefore(client, zoneName, addressChanges);
      } catch (err) {
        if (err instanceof PdnsNotFoundError)
          throw new NotFoundError(`Zone "${zoneName}" not found on backend.`);
        if (err instanceof PdnsError) throw new ValidationError(`PDNS: ${redact(err.message)}`);
        throw err;
      }
      const beforeMap = new Map(
        (zoneBefore.rrsets ?? []).map((rr) => [`${rr.name}|${rr.type}`, rr]),
      );
      for (const c of addressChanges) {
        if (!isAddressType(c.type)) continue;
        const enabled = typeof c.ptr === "boolean" ? c.ptr : zoneDefault.enabled;
        if (!enabled) continue;
        const name = normalizeName(c.name, zoneName);
        const before = beforeMap.get(`${name}|${c.type}`) ?? null;
        enabledChanges.push({
          change:
            c.kind === "upsert"
              ? {
                  kind: "upsert",
                  name,
                  type: c.type,
                  ttl: c.ttl,
                  records: dedupeRecordsByContent(c.records),
                }
              : { kind: "delete", name, type: c.type },
          before: before ? { ttl: before.ttl, records: before.records } : null,
          takeover: c.ptrTakeover === true,
        });
      }
      if (enabledChanges.length > 0) {
        ptr = await runAutoPtr({
          forwardServer: server,
          forwardZone: zoneName,
          changes: enabledChanges,
          canOnZone,
          dryRun: true,
          actor: { type: "user", id: user.id },
          request: { ip: null, userAgent: null, requestId: null },
        });
      }
    }

    return Response.json({ zoneDefault, ptr });
  } catch (err) {
    return errorResponse(err, "rrsets.ptr-plan.error");
  }
}
