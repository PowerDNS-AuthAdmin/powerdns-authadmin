/**
 * app/api/admin/pdns/zones/list/route.ts
 *
 * GET /api/admin/pdns/zones/list?serverSlug=<slug> — return the zones a
 * specific backend knows about, in the shape the export picker wants.
 * Permission: `zone.read`. No audit row (it's a UI list-fill).
 *
 * The main app already amalgamates zones across backends via the
 * realtime gateway, but the export UI needs single-backend results
 * (you export from one backend at a time, since BIND output makes no
 * cross-backend sense). That's why this endpoint exists rather than
 * reusing the amalgamated route.
 */

import { requireUser } from "@/lib/auth/require-user";
import { findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireUser({ can: "zone.read" });
    const url = new URL(request.url);
    const slug = url.searchParams.get("serverSlug");
    if (!slug) throw new ValidationError("Missing serverSlug.");

    const server = await findPdnsServerBySlug(slug);
    if (!server || server.disabledAt) {
      throw new ValidationError("Unknown or disabled PowerDNS backend.");
    }

    const client = getBackendGateway(server);
    const zones = await client.listZones();
    return Response.json({
      zones: zones.map((z) => ({ id: z.id, name: z.name, kind: z.kind })),
    });
  } catch (err) {
    return errorResponse(err, "admin.zone.list.route.error");
  }
}
