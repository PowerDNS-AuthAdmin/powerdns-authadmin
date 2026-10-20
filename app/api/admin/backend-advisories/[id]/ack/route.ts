/**
 * app/api/admin/backend-advisories/[id]/ack/route.ts
 *
 * POST - dismiss (acknowledge) one notification, removing it from the bell's
 * count until its condition changes or recurs. Kept for the bell and existing
 * API clients; the bulk form is POST /api/admin/notifications/dismiss.
 *
 * Authorization is per row: backend health needs `server.read`, a zone
 * monitoring finding needs `zone.read` on its zone (lib/health/notifications.ts).
 * A row the caller cannot see answers 404, the same as one that does not exist.
 */

import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { NotFoundError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { dismissNotifications } from "@/app/api/admin/notifications/_dismiss";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    const auth = await requireUser();
    await requireCsrf(request);
    const { id } = await context.params;
    const { dismissed } = await dismissNotifications(auth, [id]);
    if (dismissed.length === 0)
      throw new NotFoundError("Advisory not found or already acknowledged.");
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "backend-advisories.ack.error");
  }
}
