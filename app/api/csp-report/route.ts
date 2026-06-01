/**
 * app/api/csp-report/route.ts
 *
 * Receiver for Content-Security-Policy violation reports (S-20 from
 * the 2026-05-16 audit). Browsers POST a JSON document here whenever
 * a CSP directive blocks something - inline script that lacks the
 * per-request nonce, an `<img>` from a disallowed origin, a font
 * loaded over `http:` in a `connect-src` "https only" policy, etc.
 *
 * What this endpoint does:
 *   - Accepts POST with the legacy `report-uri` body shape
 *     `{ "csp-report": { ... } }` (universally supported) AND the
 *     newer Reporting-API shape `[{ type: "csp-violation", body: {...}}]`
 *     (Chrome / Edge). Both go to Pino at warn level.
 *   - Returns 204 No Content so browsers know the report landed.
 *
 * What this endpoint does NOT do (yet):
 *   - Persist reports. Filing for future work - operators need an admin
 *     UI to read them, which needs schema + UI + retention policy.
 *   - Authenticate. CSP reports come from operator browsers and from
 *     anyone-who-visits browsers; auth would lose the unauthenticated
 *     violations (which include the most security-relevant ones, like
 *     "an attacker tried to inline a script"). Unauthenticated BY DESIGN.
 *
 * Abuse controls (this endpoint is unauthenticated, so it needs them):
 *   - IP-keyed rate limit. The endpoint is a public, log-writing POST sink;
 *     without a cap an attacker could flood it to bloat logs / spend disk.
 *     Over-limit requests get a 429 before we log anything.
 *   - Bounded log payload. A hostile (or merely huge) report body is
 *     truncated before it reaches Pino, so one request can't write an
 *     arbitrarily large log line.
 *
 * Wired into CSP via the `report-uri` + `report-to` directives in
 * `proxy.ts`.
 */

import { logger } from "@/lib/logger";
import { getClientIp, getRequestId } from "@/lib/client-ip";
import { TokenBucketLimiter } from "@/lib/auth/rate-limit";
import { headers } from "next/headers";

const NO_CONTENT = new Response(null, { status: 204 });

// Dedicated bucket for this endpoint. A browser legitimately bursts a few
// reports when a page first violates the policy, then goes quiet - so allow a
// modest burst and a slow refill. Keyed per-IP; see the null-IP fallback below.
const reportLimiter = new TokenBucketLimiter({
  capacity: 20,
  refillPerSec: 1,
});

// Hard cap on how many bytes of the serialized report we hand to the logger.
// 4 KB comfortably holds a real CSP violation (directive, blocked-uri,
// source-file, line/column) while bounding the worst-case log line.
const MAX_REPORT_LOG_BYTES = 4 * 1024;

/**
 * Serialize the report and truncate to `MAX_REPORT_LOG_BYTES`. We log the
 * already-stringified form (with a truncation marker) rather than the raw
 * object so an oversized body can't blow up the log line regardless of shape.
 */
function boundReportForLog(body: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(body) ?? String(body);
  } catch {
    serialized = String(body);
  }
  if (serialized.length <= MAX_REPORT_LOG_BYTES) return serialized;
  return `${serialized.slice(0, MAX_REPORT_LOG_BYTES)}…[truncated]`;
}

export async function POST(request: Request): Promise<Response> {
  const hdrs = await headers();
  const requestId = getRequestId(hdrs);
  const ip = getClientIp(hdrs);

  // Rate-limit before doing any work or logging. When the IP is unknown
  // (no trusted proxy) we still throttle, under a single shared key - a
  // global cap is better than no cap for an unauthenticated public sink.
  const limitKey = ip ? `csp-report:${ip}` : "csp-report:unknown";
  const limit = reportLimiter.take(limitKey);
  if (!limit.allowed) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  let body: unknown;
  try {
    // CSP reports come back as application/csp-report (legacy) or
    // application/reports+json (Reporting API). Both are valid JSON;
    // `request.json()` handles either content-type as long as the
    // body parses.
    body = await request.json();
  } catch {
    // Malformed body - don't crash, just no-op. Browsers can't act
    // on the response anyway; logging the parse failure is enough.
    logger.warn(
      { contentType: request.headers.get("content-type") ?? null },
      "csp.report.parse-failed",
    );
    return NO_CONTENT;
  }

  // Single log line per report - the structured fields are searchable
  // in any log aggregator. The report is serialized and size-capped so a
  // hostile/oversized body can't write an unbounded log line; within the
  // cap the violated-directive, blocked-uri, source-file, line-number etc.
  // are all visible.
  logger.warn(
    {
      requestId,
      ip,
      userAgent: hdrs.get("user-agent") ?? null,
      report: boundReportForLog(body),
    },
    "csp.report",
  );

  return NO_CONTENT;
}
