/**
 * app/api/admin/pdns-servers/refresh-all/route.ts
 *
 * POST - operator forces a version-cache refresh of every active
 * PDNS backend in parallel. Sister of
 * `/api/admin/oidc-providers/refresh-all` (T-107). Useful after a
 * fleet upgrade or DNS migration when the operator wants every
 * backend's version_cache + capability flags to reflect the new
 * state immediately, without clicking Test on each row.
 *
 * Wraps `refreshAllBackendsHealth()` - the central per-backend health op run for
 * every backend in parallel (live probe + advisory re-sync, debounce bypassed),
 * so the inline status badges + bell reflect the fleet's true state at once.
 * This route owns auth / CSRF / audit / response shape.
 *
 * Permission: `server.read` - same as the per-server Test route.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext, getRequestId } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { refreshAllBackendsHealth } from "@/lib/realtime/backend-health";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "server.read" });
    await requireCsrf(request);

    const hdrs = await headers();
    const requestId = getRequestId(hdrs);

    const { probed, failed } = await refreshAllBackendsHealth();

    // One fleet-level audit row - per-server cache writes don't
    // audit individually (same reasoning as T-107).
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "pdns_server.refresh-all",
      resource: { type: "pdns_server", id: null },
      after: { serversProbed: probed, failed },
      request: getRequestContext(hdrs),
    });

    logger.info({ probed, failed, requestId, userId: user.id }, "pdns.servers.refresh-all.ok");
    return Response.json({ ok: true, probed, failed, requestId });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "pdns.servers.refresh-all.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
