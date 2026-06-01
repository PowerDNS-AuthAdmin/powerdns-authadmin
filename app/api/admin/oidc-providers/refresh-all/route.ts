/**
 * app/api/admin/oidc-providers/refresh-all/route.ts
 *
 * POST - operator forces a discovery re-probe of every enabled OIDC
 * provider, bypassing the T-103 sampler's 15-minute staleness gate.
 * Useful after a bulk config change (DNS migration, IdP version
 * upgrade) when the operator wants immediate confirmation that
 * everything still resolves.
 *
 * Wraps `sampleAllOidcDiscoveryNow()` (T-103). The wrapper already
 * runs probes in parallel + catches per-provider failures, so this
 * route just needs auth/CSRF/audit + counting.
 *
 * Permission: `oidc.read` (same as the per-provider Test route).
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext, getRequestId } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { sampleAllOidcDiscoveryNow } from "@/lib/auth/providers/oidc-discovery-sampler";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export async function POST(request: Request): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "auth.read" });
    await requireCsrf(request);

    const hdrs = await headers();
    const requestId = getRequestId(hdrs);

    const probed = await sampleAllOidcDiscoveryNow();

    // Audit at the fleet level - per-provider cache writes carry
    // their own record via the sampler's setOidcDiscoveryCache call,
    // and the audit row noise from N writers would dwarf the signal.
    // One "operator ran refresh-all, N providers covered" entry.
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "oidc.provider.refresh-all",
      resource: { type: "oidc_provider", id: null },
      after: { providersProbed: probed },
      request: getRequestContext(hdrs),
    });

    logger.info({ probed, requestId, userId: user.id }, "oidc.providers.refresh-all.ok");
    return Response.json({ ok: true, probed, requestId });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    logger.error(
      { err: err instanceof Error ? err.message : "unknown" },
      "oidc.providers.refresh-all.error",
    );
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
