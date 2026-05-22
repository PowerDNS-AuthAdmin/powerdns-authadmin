/**
 * app/api/admin/pdns-servers/[id]/test/route.ts
 *
 * POST — actively probe the backend. On success: returns the resolved
 * version, server-id, and capability flags, and persists the snapshot to
 * `version_cache`. On failure: returns ONLY a coarse classification +
 * static hint + the request-id. The detailed error (raw message, stack,
 * upstream status, target host) stays in server logs.
 *
 * S-12 motivation: the prior version returned the raw upstream error in
 * the response body. For an admin with `server.read` that gave them a
 * fingerprint oracle for internal services — "connect ECONNREFUSED
 * 10.0.0.5:8081" tells you the host exists but the port is closed,
 * "DNS lookup failed" tells you the hostname is invalid, etc. Operators
 * who genuinely need the underlying error can still pull it from the log
 * line via the request-id correlator.
 */

import { headers } from "next/headers";
import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { getRequestId } from "@/lib/client-ip";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { logger } from "@/lib/logger";
import { safeErrorMessage } from "@/lib/errors/redact";
import { refreshAndPersistVersion } from "@/lib/pdns/registry";
import {
  PdnsAuthError,
  PdnsError,
  PdnsNotFoundError,
  PdnsUpstreamError,
  PdnsValidationError,
} from "@/lib/pdns/errors";

type TestKind = "auth" | "reachable" | "unreachable" | "unknown";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireUser({ can: "server.read" });
    await requireCsrf(request);
    const { id } = await context.params;
    const hdrs = await headers();
    const requestId = getRequestId(hdrs);

    try {
      const { cache, persisted } = await refreshAndPersistVersion(id);
      return Response.json({ ok: true, persisted, cache, requestId });
    } catch (err) {
      // Row-missing is a routing 404, not a "test outcome". Surface as 404.
      if (err instanceof NotFoundError) {
        throw err;
      }
      const classification = classify(err);
      logger.warn(
        {
          serverId: id,
          requestId,
          kind: classification.kind,
          // safeErrorMessage strips known secret shapes (URL-embedded
          // passwords, bearer tokens, PEM blocks, JWTs, PATs) but leaves
          // structural details like hostnames / ports / status codes
          // intact — appropriate for a server-side log.
          err: safeErrorMessage(err),
        },
        "pdns.server.test.failed",
      );
      return Response.json(
        {
          ok: false,
          kind: classification.kind,
          hint: classification.hint,
          requestId,
        },
        { status: 200 }, // The admin form shows the failure inline, not as an HTTP error.
      );
    }
  } catch (err) {
    return errorResponse(err, "pdns-servers.test.route.error");
  }
}

function classify(err: unknown): { kind: TestKind; hint: string } {
  if (err instanceof PdnsAuthError) {
    return {
      kind: "auth",
      hint: "PDNS rejected the API key. Verify the X-API-Key value stored for this server.",
    };
  }
  if (
    err instanceof PdnsNotFoundError ||
    err instanceof PdnsValidationError ||
    err instanceof PdnsError
  ) {
    return {
      kind: "reachable",
      hint: "The server responded, but the request was rejected. Review the server-side log for this request-id for the underlying error.",
    };
  }
  if (err instanceof PdnsUpstreamError) {
    return {
      kind: "unreachable",
      hint: "The PDNS server did not respond. Verify the URL is reachable from this app's network and the service is listening.",
    };
  }
  return {
    kind: "unknown",
    hint: "An unexpected error occurred during the test. Review the server-side log for this request-id for details.",
  };
}
