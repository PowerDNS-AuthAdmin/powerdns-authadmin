/**
 * app/api/admin/notifications/dismiss/route.ts
 *
 * POST { ids: string[] } - dismiss notifications in bulk (the Notifications
 * page's "Dismiss all shown", MCP `dismiss_notifications`). CSRF-protected;
 * each id is checked against the caller's own visibility, see _dismiss.ts.
 * Dismissing hides a notification until its condition changes or recurs.
 */

import { z } from "zod";
import { requireCsrf } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/require-user";
import { ValidationError } from "@/lib/errors";
import { errorResponse } from "@/lib/http/error-response";
import { MAX_DISMISS_BATCH, dismissNotifications } from "../_dismiss";

const Body = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_DISMISS_BATCH),
});

export async function POST(request: Request): Promise<Response> {
  try {
    const auth = await requireUser();
    await requireCsrf(request);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new ValidationError("Expected { ids: string[] } (1 to 500 ids).");
    const result = await dismissNotifications(auth, parsed.data.ids);
    return Response.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err, "notifications.dismiss.error");
  }
}
