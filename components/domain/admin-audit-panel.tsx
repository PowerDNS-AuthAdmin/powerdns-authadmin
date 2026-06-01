/**
 * components/domain/admin-audit-panel.tsx
 *
 * Reusable compact audit feed for admin resource detail pages.
 * Renders the most-recent N audit rows scoped to one resource id
 * - used by /admin/servers/[id] and /admin/authentication/oidc/[id]
 *. The full audit page at /admin/audit remains the
 * source of truth for searchable/filterable history; this is the
 * at-a-glance window so operators don't have to leave the detail
 * page to see "what's been happening here lately."
 *
 * Server component. Pre-formats timestamps via the `freshnessOf`
 * helper so the client doesn't redo Date math (project-
 * hydration-locale-dates rule).
 *
 * Accepts a plain array shaped like the repo's `ZoneAuditEntry`
 * (kept structural so callers don't have to import the type from
 * lib/db).
 */

import Link from "next/link";
import { freshnessOf } from "@/lib/freshness";
import { colorForAuditAction } from "@/lib/audit/action-color";
import { LiveFeedSubscriber } from "@/components/ui/live-feed-subscriber";

export interface AdminAuditRow {
  id: string;
  ts: Date;
  actorType: "user" | "token" | "system";
  actorEmail: string | null;
  actorId: string | null;
  action: string;
}

interface Props {
  /** Rows to render, newest first. Pass an empty array to hide. */
  entries: ReadonlyArray<{
    id: string;
    ts: Date;
    actorType: "user" | "token" | "system";
    actorEmail: string | null;
    action: string;
  }>;
  /** Optional anchor + label for the "See full history" link. */
  fullHistoryHref?: string;
}

export function AdminAuditPanel({ entries, fullHistoryHref }: Props) {
  return (
    <section className="rounded-md border border-[color:var(--color-border)] p-4">
      <header className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Recent admin activity ({entries.length})
          </h2>
          <LiveFeedSubscriber eventTypes={["audit.appended"]} />
        </div>
        {fullHistoryHref ? (
          <Link
            href={fullHistoryHref}
            className="text-xs text-[color:var(--color-accent)] hover:underline"
          >
            See full audit log →
          </Link>
        ) : null}
      </header>

      {entries.length === 0 ? (
        <p className="text-sm text-[color:var(--color-fg-muted)]">
          No admin activity recorded yet for this resource.
        </p>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)] text-sm">
          {entries.map((entry) => {
            const fresh = freshnessOf(entry.ts.toISOString());
            return (
              <li key={entry.id} className="flex items-baseline justify-between gap-3 py-2">
                <div className="min-w-0 flex-1 truncate">
                  <code
                    className={`rounded px-1.5 py-0.5 font-mono text-[0.6875rem] tracking-wide uppercase ${colorForAuditAction(entry.action)}`}
                  >
                    {entry.action}
                  </code>{" "}
                  <span className="text-[color:var(--color-fg-muted)]">
                    by{" "}
                    {entry.actorEmail ? (
                      <span className="font-mono">{entry.actorEmail}</span>
                    ) : entry.actorType === "system" ? (
                      "system"
                    ) : (
                      entry.actorType
                    )}
                  </span>
                </div>
                <span className="shrink-0 text-xs text-[color:var(--color-fg-muted)]">
                  {fresh.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
