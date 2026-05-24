/**
 * app/api/admin/backend-advisories/[id]/ack/route.ts
 *
 * POST — acknowledge a health advisory (ADR-0015), removing it from the bell's
 * unacked count. Gated by `server.read` (the bell's audience); acknowledging is
 * dismissing a notification, not changing backend config. If the underlying
 * condition recurs after the advisory clears, a fresh row is created un-acked.
 */

import { requireUser } from "@/lib/auth/require-user";
import { requireCsrf } from "@/lib/auth/csrf";
import { errorResponse } from "@/lib/http/error-response";
import { NotFoundError } from "@/lib/errors";
import { acknowledgeAdvisory } from "@/lib/db/repositories/backend-advisories";
import { publishHealthEvent } from "@/lib/realtime/event-bus";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    await requireUser({ can: "server.read" });
    await requireCsrf(request);
    const { id } = await context.params;
    const ok = await acknowledgeAdvisory(id);
    if (!ok) throw new NotFoundError("Advisory not found or already acknowledged.");
    // Acking drops it from the unacked count for everyone — nudge other bells.
    publishHealthEvent();
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "backend-advisories.ack.error");
  }
}
