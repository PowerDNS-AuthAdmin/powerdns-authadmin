/**
 * app/api/admin/notifications/route.ts
 *
 * GET - the notifications this user may see (backend health and zone
 * monitoring), active first, with a summary. Each row is filtered by its own
 * scope (lib/health/notifications.ts), so the response is safe for any
 * authenticated user; one with no server or zone access gets an empty list.
 * Used by the MCP `list_notifications` tool; the pages render server-side.
 */

import { requireUser } from "@/lib/auth/require-user";
import { ValidationError } from "@/lib/errors";
import { loadNotificationsFor } from "@/lib/health/load-notifications";
import { summarizeNotifications } from "@/lib/health/notifications";
import { errorResponse } from "@/lib/http/error-response";

export async function GET(request: Request): Promise<Response> {
  try {
    const auth = await requireUser();
    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? "active";
    if (status !== "active" && status !== "all") throw new ValidationError("Invalid status.");
    const all = await loadNotificationsFor(auth);
    const notifications = status === "all" ? all : all.filter((n) => !n.acknowledged);
    return Response.json(
      { summary: summarizeNotifications(all), notifications },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err, "notifications.list.error");
  }
}
