/**
 * app/api/admin/notifications/_dismiss.ts
 *
 * Dismissing (acknowledging) notifications, shared by the bulk route and the
 * legacy single-advisory route. Every id is checked against what this user
 * may see, so a zone-scoped user can dismiss the findings for their zones and
 * nothing else; unknown, invisible and already-dismissed ids are reported
 * back as skipped without saying which was which.
 */

import "server-only";
import { headers } from "next/headers";
import type { AuthenticatedRequest } from "@/lib/auth/get-current-user";
import { appendAudit } from "@/lib/audit/log";
import { getRequestContext } from "@/lib/client-ip";
import { acknowledgeAdvisory } from "@/lib/db/repositories/backend-advisories";
import { loadNotificationsFor } from "@/lib/health/load-notifications";
import { publishHealthEvent } from "@/lib/realtime/event-bus";

export const MAX_DISMISS_BATCH = 500;

export async function dismissNotifications(
  auth: AuthenticatedRequest,
  ids: readonly string[],
): Promise<{ dismissed: string[]; skipped: number }> {
  const dismissable = new Set(
    (await loadNotificationsFor(auth)).filter((n) => !n.acknowledged).map((n) => n.id),
  );
  const request = getRequestContext(await headers());
  const dismissed: string[] = [];
  for (const id of new Set(ids)) {
    if (!dismissable.has(id)) continue;
    const advisory = await acknowledgeAdvisory(id);
    if (!advisory) continue;
    dismissed.push(id);
    await appendAudit({
      actor: { type: "user", id: auth.user.id },
      action: "backend_advisory.acknowledge",
      resource: { type: "backend_advisory", id: advisory.id },
      before: { ...advisory, acknowledgedAt: null },
      after: advisory,
      request,
    });
  }
  // Dismissing changes the bell for everyone who sees these rows.
  if (dismissed.length > 0) publishHealthEvent();
  return { dismissed, skipped: new Set(ids).size - dismissed.length };
}
