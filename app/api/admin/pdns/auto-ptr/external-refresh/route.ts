/**
 * app/api/admin/pdns/auto-ptr/external-refresh/route.ts
 *
 * POST - look up, now, what the world answers for every address the Reverse
 * DNS page cannot host. Permission: global `record.read` (same as the report).
 * Rate-limited; a refused call answers 429.
 */

import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { reconcilePtrs } from "@/lib/dns/ptr-reconcile";
import { errorResponse } from "@/lib/http/error-response";
import { MANUAL_REFRESH_INTERVAL_MS, refreshExternalNow } from "@/lib/monitoring/external-ptr";
import { getFleetScan } from "../_scan";
import { requireFeature } from "@/lib/http/require-feature";

export async function POST(request: Request): Promise<Response> {
  try {
    requireFeature("reverseDns");
    await requireUser({ can: "record.read" });
    await requireCsrf(request);
    const scan = await getFleetScan();
    const { rows } = reconcilePtrs({
      forward: scan.forward,
      reverse: scan.reverse,
      hostedReverseZones: scan.hostedReverseZones,
      canWriteReverse: () => false,
    });
    const unhosted = rows
      .filter((r) => r.status === "unhosted")
      .map((r) => ({ ip: r.ip, horizon: r.horizon }));
    const ran = await refreshExternalNow(unhosted);
    if (!ran) {
      return Response.json(
        {
          error: `External lookups run on demand once every ${MANUAL_REFRESH_INTERVAL_MS / 1000} seconds.`,
        },
        { status: 429 },
      );
    }
    return Response.json({ ok: true, looked: unhosted.length });
  } catch (err) {
    return errorResponse(err, "auto-ptr.external-refresh.error");
  }
}
