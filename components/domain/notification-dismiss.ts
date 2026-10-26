/**
 * components/domain/notification-dismiss.ts
 *
 * Client-side dismissal through `POST /api/admin/notifications/dismiss`, shared
 * by the bell and the Notifications page. A grouped finding can carry more ids
 * than the route takes in one call, so they go in batches; the route re-checks
 * each id against the caller's visibility.
 */

import { apiFetch } from "@/lib/client/api-fetch";

/** Mirrors MAX_DISMISS_BATCH in app/api/admin/notifications/_dismiss.ts. */
const DISMISS_BATCH = 500;

export type DismissOutcome = { ok: true; dismissed: number } | { ok: false; error: string };

export async function dismissNotificationIds(ids: readonly string[]): Promise<DismissOutcome> {
  let dismissed = 0;
  for (let i = 0; i < ids.length; i += DISMISS_BATCH) {
    let res: Response;
    try {
      res = await apiFetch("/api/admin/notifications/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.slice(i, i + DISMISS_BATCH) }),
      });
    } catch {
      return {
        ok: false,
        error:
          dismissed > 0
            ? `Network error after ${dismissed} were dismissed.`
            : "Network error - nothing was changed.",
      };
    }
    const data = (await res.json().catch(() => null)) as {
      dismissed?: string[];
      error?: string;
    } | null;
    if (!res.ok) return { ok: false, error: data?.error ?? `The server answered ${res.status}.` };
    dismissed += data?.dismissed?.length ?? 0;
  }
  return { ok: true, dismissed };
}
