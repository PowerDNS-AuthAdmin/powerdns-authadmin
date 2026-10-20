/**
 * app/api/admin/monitoring/zones/refresh/route.ts
 *
 * POST - run the checks now: for one zone (`{ zone, serverSlug }`) or for the
 * whole fleet (empty body). Permission: global `zone.read`; CSRF-protected
 * like every mutating-shaped route. Rate-limited in the monitor, so a refused
 * run answers 429 with the retry interval rather than probing again.
 */

import { z, ZodError } from "zod";
import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { findPdnsServerBySlug } from "@/lib/db/repositories/pdns-servers";
import { canonicalZone } from "@/lib/dns/reverse-name";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import {
  getZoneMonitorState,
  MANUAL_REFRESH_INTERVAL_MS,
  refreshAllZones,
  refreshZone,
} from "@/lib/monitoring/zone-monitor";
import { requireFeature } from "@/lib/http/require-feature";

const bodySchema = z
  .object({
    zone: z
      .string()
      .regex(/^[A-Za-z0-9._\-/]{1,255}$/, "Invalid zone.")
      .optional(),
    serverSlug: z.string().min(1).max(100).optional(),
  })
  .default({});

export async function POST(request: Request): Promise<Response> {
  try {
    requireFeature("zoneMonitoring");
    await requireUser({ can: "zone.read" });
    await requireCsrf(request);
    let body: z.infer<typeof bodySchema>;
    try {
      const text = await request.text();
      body = bodySchema.parse(text ? JSON.parse(text) : {});
    } catch (err) {
      if (err instanceof ZodError)
        throw new ValidationError("Invalid input.", { fieldErrors: err.flatten().fieldErrors });
      throw new ValidationError("Invalid input.");
    }
    if (body.zone) {
      if (!body.serverSlug) throw new ValidationError("serverSlug is required with zone.");
      const server = await findPdnsServerBySlug(body.serverSlug);
      if (server?.disabledAt !== null)
        throw new ValidationError("Unknown or disabled PowerDNS backend.");
      const result = await refreshZone(canonicalZone(body.zone), server.slug);
      if (result === false)
        return Response.json({ error: "Checked recently; try again shortly." }, { status: 429 });
      return Response.json({ result });
    }
    const ran = await refreshAllZones();
    if (!ran) {
      return Response.json(
        { error: `A full run is allowed once every ${MANUAL_REFRESH_INTERVAL_MS / 1000} seconds.` },
        { status: 429 },
      );
    }
    return Response.json(getZoneMonitorState());
  } catch (err) {
    return errorResponse(err, "monitoring.zones.refresh.error");
  }
}
