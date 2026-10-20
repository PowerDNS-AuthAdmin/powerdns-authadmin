/**
 * app/api/admin/monitoring/zones/route.ts
 *
 * GET - the latest zone monitoring results (in-memory; recomputed every
 * cycle). Permission: global `zone.read`. Starting the monitor here as well as
 * from the app shell means the first visit after a boot never shows an empty
 * page for long.
 */

import { requireUser } from "@/lib/auth/require-user";
import { errorResponse } from "@/lib/http/error-response";
import { ensureZoneMonitorRunning, getZoneMonitorState } from "@/lib/monitoring/zone-monitor";

export async function GET(): Promise<Response> {
  try {
    await requireUser({ can: "zone.read" });
    ensureZoneMonitorRunning();
    return Response.json(getZoneMonitorState());
  } catch (err) {
    return errorResponse(err, "monitoring.zones.error");
  }
}
