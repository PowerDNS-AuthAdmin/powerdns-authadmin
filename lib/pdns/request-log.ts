/**
 * lib/pdns/request-log.ts
 *
 * Fire-and-forget recorder for the `pdns_requests` table. Called by the
 * PDNS HTTP client after every request so the change-history feed and
 * the audit log can show the actual outbound HTTP traffic per operation.
 *
 * Sensitive material is redacted before insertion:
 *   - `X-API-Key` header → `<redacted>`
 *   - Any header whose name matches `/auth|token|secret|key/i`
 *
 * The response body is intentionally NOT stored - only the response
 * status code. Storing PDNS' responses (zone listings, full rrset
 * dumps) would balloon the table and rarely adds diagnostic value
 * beyond the status. Bodies stay in the live PDNS - the log captures
 * intent + outcome.
 */

/* eslint-disable no-restricted-imports -- Sanctioned lib/pdns→lib/db bridge:
   the fire-and-forget recorder that persists each outbound PDNS HTTP call into
   the `pdns_requests` table from the dispatcher's hook. See ADR-0013. */
import "server-only";
import { db } from "@/lib/db";
import { pdnsRequests } from "@/lib/db/schema";
import { publishPdnsRequestEvent } from "@/lib/realtime/event-bus";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";

export interface PdnsRequestLogInput {
  requestId: string | null;
  serverDbId: string | null;
  serverSlug: string;
  op: string;
  method: string;
  url: string;
  /** Raw outbound headers including `X-API-Key`; we redact before write. */
  requestHeaders: Record<string, string>;
  /** Raw outbound body (parsed JSON object, string, or null). */
  requestBody: unknown;
  /** HTTP status from PDNS, or null when the request never completed. */
  responseStatus: number | null;
  /** Transport / parse / abort error, when applicable. */
  error: string | null;
}

const REDACTED = "<redacted>";

/**
 * Insert one row into `pdns_requests`. Errors are swallowed and logged
 * - a failed audit insert must NEVER block the upstream PDNS call.
 */
export function recordPdnsRequest(input: PdnsRequestLogInput): void {
  // Fire-and-forget. The caller is mid-PDNS-call and can't afford to wait.
  void (async () => {
    try {
      await db.insert(pdnsRequests).values({
        requestId: input.requestId,
        serverId: input.serverDbId,
        serverSlug: input.serverSlug,
        op: input.op,
        method: input.method,
        // A misconfigured backend URL can carry credentials in its userinfo
        // (`scheme://user:pass@host`). Run the URL through the same redactor used
        // for error strings so we never persist them verbatim into the log table.
        url: redact(input.url),
        requestHeaders: redactHeaders(input.requestHeaders),
        requestBody: normalizeBody(input.requestBody),
        responseStatus: input.responseStatus,
        error: input.error ? redact(input.error) : null,
      });
      publishPdnsRequestEvent({
        type: "pdns.request.appended",
        serverSlug: input.serverSlug,
        op: input.op,
        method: input.method,
        responseStatus: input.responseStatus,
        at: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown", op: input.op },
        "pdns.request-log.write-failed",
      );
    }
  })();
}

function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(h)) {
    if (isSensitiveHeader(key)) out[key] = REDACTED;
    else out[key] = value;
  }
  return out;
}

function isSensitiveHeader(name: string): boolean {
  return /api[-_]?key|auth|token|secret|cookie/i.test(name);
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  // Objects round-trip through JSONB cleanly. Strings and primitives
  // wrap as `{ raw: ... }` so the viewer can render them without
  // assuming an object shape.
  if (typeof body === "object") return body;
  return { raw: body };
}
