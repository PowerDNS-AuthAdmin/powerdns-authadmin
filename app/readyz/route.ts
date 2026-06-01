/**
 * app/readyz/route.ts
 *
 * Readiness probe. Returns 200 only when the app can actually serve traffic -
 * specifically, when the database is reachable. (A future iteration may also
 * verify that at least one PowerDNS backend is reachable.)
 *
 * Distinction from /healthz: liveness ("is the process alive?") vs readiness
 * ("can this instance handle a request right now?"). A momentary DB blip should
 * not trigger a pod restart; it should pull this instance out of rotation until
 * the DB recovers.
 *
 * Response body is informational only; the status code is what callers check.
 */

import { pingDatabase } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const dbOk = await pingDatabase();

  // Future: also check at least one PDNS backend, and Redis if configured.
  const checks: Record<string, "ok" | "fail"> = {
    database: dbOk ? "ok" : "fail",
  };

  const allOk = Object.values(checks).every((v) => v === "ok");

  return Response.json(
    { status: allOk ? "ok" : "degraded", checks },
    {
      status: allOk ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
