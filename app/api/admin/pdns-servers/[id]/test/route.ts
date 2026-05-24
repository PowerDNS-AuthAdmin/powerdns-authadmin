/**
 * app/api/admin/pdns-servers/[id]/test/route.ts
 *
 * POST — actively probe the backend, NOW, through the one central health op
 * (`refreshBackendHealth`, immediate). It runs the same listZones-based
 * reachability probe the background poll uses and authoritatively re-syncs the
 * advisory (debounce bypassed), so the Test result, the status badge, and the
 * bell agree the instant the operator clicks.
 *
 * On reachable: returns the live version. On failure: returns ONLY a coarse
 * classification (auth vs unreachable) + a static hint. The detailed error
 * stays in the server log (S-12: the raw upstream error is a fingerprint oracle
 * for internal services to an admin with only `server.read`).
 */

import { headers } from "next/headers";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { getRequestId } from "@/lib/client-ip";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { findPdnsServerById } from "@/lib/db/repositories/pdns-servers";
import { refreshBackendHealth } from "@/lib/realtime/backend-health";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireUser({ can: "server.read" });
    await requireCsrf(request);
    const { id } = await context.params;
    const requestId = getRequestId(await headers());

    const row = await findPdnsServerById(id);
    if (!row) throw new NotFoundError("PowerDNS server not found.");

    const outcome = await refreshBackendHealth(row, { immediate: true });
    if (outcome.reachable) {
      return Response.json({ ok: true, cache: { version: outcome.version }, requestId });
    }
    // Unreachable outcomes ride back in the body (200) so the admin form shows
    // them inline rather than as an HTTP error.
    return Response.json(
      {
        ok: false,
        kind: outcome.authError ? "auth" : "unreachable",
        hint: outcome.authError
          ? "PDNS rejected the API key (401/403). Verify the X-API-Key and the webserver/api ACL."
          : "The backend's API didn't respond as expected. Check the daemon is running, api=yes is set, the URL + server-id are correct, and the network path is open.",
        requestId,
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err, "pdns-servers.test.route.error");
  }
}
