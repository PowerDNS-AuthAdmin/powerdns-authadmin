/**
 * app/api/admin/pdns/zones/import/route.ts
 *
 * Import one or more BIND zonefiles. The body's `zoneText` may contain
 * multiple zones separated by `$ORIGIN <fqdn>.` directives — the parser
 * splits them. Each parsed zone becomes one `createZone` call against
 * the chosen backend; rrsets ride along inside that single call so
 * there's no separate PATCH pass.
 *
 * Permission: `zone.create` (same gate as the regular create-zone API).
 *
 * The handler is best-effort per-zone: a parse or create failure on one
 * zone doesn't abort the rest. The response carries a structured
 * per-zone status array so the UI can show "3 created, 1 failed (here's
 * why)" rather than a flat 500.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { PdnsError } from "@/lib/pdns/errors";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { parseZonefile } from "@/lib/dns/zonefile-parser";

const importSchema = z.object({
  serverSlug: z.string().min(1),
  zoneText: z.string().min(1).max(2 * 1024 * 1024), // 2 MiB cap — enough for a Fortune-500 worth of records
  kind: z.enum(["Master", "Primary", "Native"]).default("Master"),
});

interface ZoneImportResult {
  name: string;
  status: "created" | "failed";
  rrsetCount: number;
  error?: string;
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "zone.create" });
    await requireCsrf(request);

    let input;
    try {
      input = importSchema.parse(await request.json());
    } catch (err) {
      if (err instanceof ZodError) {
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      }
      throw err;
    }

    const server = await findPdnsServerBySlug(input.serverSlug);
    if (!server || server.disabledAt) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    // Parse errors return 200 with `ok:false` rather than 4xx so the client
    // gets the full `diagnostics` array (the `mutate()` helper discards body
    // on non-2xx). Auth/CSRF/Zod shape errors still 4xx via errorResponse.
    const parsed = parseZonefile(input.zoneText);
    if (parsed.zones.length === 0) {
      return Response.json({
        ok: false,
        error: "No zones found in input.",
        results: [],
        diagnostics: parsed.diagnostics,
      });
    }

    const errorDiagnostics = parsed.diagnostics.filter((d) => d.level === "error");
    if (errorDiagnostics.length > 0) {
      return Response.json({
        ok: false,
        error: "Parse errors — fix and retry.",
        results: [],
        diagnostics: parsed.diagnostics,
      });
    }

    const client = getBackendGateway(server);
    const results: ZoneImportResult[] = [];
    const hdrs = await headers();
    const reqCtx = getRequestContext(hdrs);

    for (const zone of parsed.zones) {
      // PDNS' createZone expects an empty `nameservers` array when NS
      // records ride in `rrsets` (the two are mutually exclusive on the
      // wire). Our parser puts NS records in rrsets, so we pass them
      // through that side only.
      const wireRrsets = zone.rrsets.map((rr) => ({
        name: rr.name,
        type: rr.type,
        ttl: rr.ttl,
        changetype: "REPLACE" as const,
        records: rr.records.map((r) => ({ content: r.content, disabled: false })),
      }));

      try {
        const created = await client.createZone({
          name: zone.name,
          kind: input.kind,
          rrsets: wireRrsets,
        });
        results.push({
          name: zone.name,
          status: "created",
          rrsetCount: zone.rrsets.length,
        });
        await appendAudit({
          actor: { type: "user", id: user.id },
          action: "zone.create",
          resource: { type: "zone", id: created.id },
          after: { name: zone.name, source: "zonefile-import", rrsets: zone.rrsets.length },
          request: reqCtx,
        });
      } catch (err) {
        const message =
          err instanceof PdnsError ? redact(err.message) : err instanceof Error ? err.message : "unknown";
        logger.warn(
          { zone: zone.name, server: server.slug, err: message },
          "pdns.zone.import.failed",
        );
        results.push({
          name: zone.name,
          status: "failed",
          rrsetCount: zone.rrsets.length,
          error: message,
        });
      }
    }

    const ok = results.every((r) => r.status === "created");
    return Response.json({
      ok,
      results,
      diagnostics: parsed.diagnostics,
    });
  } catch (err) {
    return errorResponse(err, "admin.zone.import.route.error");
  }
}
