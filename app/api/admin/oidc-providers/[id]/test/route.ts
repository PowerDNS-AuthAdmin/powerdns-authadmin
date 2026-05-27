/**
 * app/api/admin/oidc-providers/[id]/test/route.ts
 *
 * POST — operator probes the OIDC issuer's discovery endpoint and
 * persists the result on the provider row's `discoveryCache`. The
 * admin list page reads the cache to render a health badge.
 *
 * Same shape as the PDNS server `/test` route:
 *   - Gated by `oidc.read` (anyone with list access can re-probe).
 *   - Returns `{ ok: true }` on success.
 *   - Returns `{ ok: false, reason, hint }` on failure (in-band 200
 *     so the form can render the result inline). Hint is the
 *     `probeFailureLabel` human string; raw network/HTTP details
 *     stay in the server log via the request-id.
 *
 * Why not just call this on every list render: the probe hits the
 * IdP every time, which is rude at scale and creates an N+1 fanout.
 * Operator-on-demand keeps the badge fresh enough without that.
 */

import { headers } from "next/headers";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext, getRequestId } from "@/lib/client-ip";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { findOidcProviderById, setOidcDiscoveryCache } from "@/lib/db/repositories/oidc-providers";
import {
  probeFailureLabel,
  probeOidcDiscovery,
  type ProbeResult,
} from "@/lib/auth/providers/oidc-probe";
import { checkOidcIssuerUrlSafe } from "@/lib/auth/providers/oidc-url-safety";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";
import { logger } from "@/lib/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const { user } = await requireUser({ can: "oidc.read" });
    await requireCsrf(request);
    const { id } = await context.params;
    const hdrs = await headers();
    const requestId = getRequestId(hdrs);

    const provider = await findOidcProviderById(id);
    if (!provider) throw new NotFoundError("OIDC provider not found.");

    // Re-validate the (persisted) issuer URL before fetching — DNS-rebind
    // defense, and surfaces a now-unsafe URL as a normal in-band test failure.
    const safety = await checkOidcIssuerUrlSafe(provider.issuerUrl);
    const result: ProbeResult = safety.safe
      ? await probeOidcDiscovery(provider.issuerUrl)
      : { ok: false, reason: "transport" };
    const failureHint = result.ok
      ? undefined
      : safety.safe
        ? probeFailureLabel(result.reason)
        : safety.reason;
    const fetchedAt = new Date().toISOString();
    await setOidcDiscoveryCache(id, {
      fetchedAt,
      ok: result.ok,
      ...(result.ok
        ? { endSessionEndpoint: result.endSessionEndpoint }
        : { reason: result.reason }),
    });

    // Audit BOTH outcomes — operator-visible diagnostics for "we
    // tested at T, here's what we found." Cache is on the row; the
    // audit row has the historic decision trail.
    await appendAudit({
      actor: { type: "user", id: user.id },
      action: "oidc.provider.updated",
      resource: { type: "oidc_provider", id },
      after: { discoveryProbe: { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) } },
      request: getRequestContext(hdrs),
    });

    if (!result.ok) {
      logger.warn(
        { providerId: id, reason: result.reason, requestId },
        "oidc.provider.test.failed",
      );
      return Response.json(
        {
          ok: false,
          reason: result.reason,
          hint: failureHint,
          requestId,
        },
        { status: 200 },
      );
    }

    return Response.json({ ok: true, fetchedAt, requestId });
  } catch (err) {
    if (err instanceof UnauthorizedError)
      return Response.json({ error: err.message }, { status: 401 });
    if (err instanceof ForbiddenError)
      return Response.json({ error: err.message }, { status: 403 });
    if (err instanceof NotFoundError) return Response.json({ error: err.message }, { status: 404 });
    return Response.json({ error: "Internal error." }, { status: 500 });
  }
}
