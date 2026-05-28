/**
 * app/api/admin/pdns/zones/export/route.ts
 *
 * Bulk export selected zones from a single backend as one concatenated
 * BIND-format text bundle. Each zone is rendered with `formatZonefile()`
 * and the bundle starts with a generated comment header.
 *
 * Permission: `zone.read`. Audits each successful fetch as `zone.read`
 * (one row per zone) so the export is traceable.
 *
 * Response is `text/plain; charset=utf-8` with a `Content-Disposition`
 * attachment filename derived from server slug + timestamp.
 */

import { headers } from "next/headers";
import { z, ZodError } from "zod";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { logger } from "@/lib/logger";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { formatZonefile } from "@/lib/dns/zonefile-formatter";

const exportSchema = z.object({
  serverSlug: z.string().min(1),
  zones: z.array(z.string().min(1)).min(1).max(500),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "zone.read" });
    await requireCsrf(request);

    let input;
    try {
      input = exportSchema.parse(await request.json());
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

    const client = getBackendGateway(server);
    const hdrs = await headers();
    const reqCtx = getRequestContext(hdrs);

    const now = new Date();
    const bundleHeader = [
      `Exported from ${server.name} (${server.slug}) at ${now.toISOString()}`,
      `Zones: ${input.zones.length}`,
    ];

    const pieces: string[] = [`; ${bundleHeader[0]}`, `; ${bundleHeader[1]}`, ""];
    const errors: Array<{ zone: string; error: string }> = [];

    for (const zoneName of input.zones) {
      try {
        const detail = await client.getZone(zoneName);
        pieces.push(formatZonefile(detail, { header: [`Zone: ${detail.name}`] }));
        await appendAudit({
          actor: { type: "user", id: user.id },
          action: "zone.export",
          resource: { type: "zone", id: detail.id },
          after: { name: detail.name },
          request: reqCtx,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown";
        logger.warn(
          { zone: zoneName, server: server.slug, err: message },
          "pdns.zone.export.failed",
        );
        errors.push({ zone: zoneName, error: message });
        pieces.push(`; ERROR exporting ${zoneName}: ${message}`);
        pieces.push("");
      }
    }

    const filename = `${server.slug}-zones-${now.toISOString().slice(0, 10)}.txt`;
    const responseHeaders: Record<string, string> = {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-export-zone-count": String(input.zones.length - errors.length),
      "x-export-error-count": String(errors.length),
    };
    return new Response(pieces.join("\n"), { headers: responseHeaders });
  } catch (err) {
    return errorResponse(err, "admin.zone.export.route.error");
  }
}
