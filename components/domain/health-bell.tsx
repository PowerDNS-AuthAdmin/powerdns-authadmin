"use client";

/**
 * components/domain/health-bell.tsx
 *
 * Top-bar notification bell (ADR-0015): backend health and zone monitoring.
 * The server passes a short preview (the most pressing few, already filtered
 * to what this user may see) and the counts, not the whole list, so a fleet
 * with hundreds of findings costs every page render nothing extra. "Show all"
 * opens the Notifications page. The same finding on many zones shows as one
 * entry ("SOA MNAME is not one of the nameservers, 117 zones") with a link to
 * fix them together. Dismissing POSTs to the dismiss route, which re-checks
 * visibility, then refreshes in place.
 *
 * Presentational only - no lib/db / lib/pdns imports (three-layer boundary).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Bell, CheckCircle2 } from "lucide-react";
import {
  entryIds,
  entryKey,
  type NotificationEntry,
  type NotificationSummary,
} from "@/lib/health/notifications";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { dismissNotificationIds } from "@/components/domain/notification-dismiss";
import {
  badgeCount,
  bellLabel,
  entryView,
  severityDotClass,
  severityWord,
  summaryLine,
} from "@/components/domain/notification-format";

export function HealthBell({
  preview,
  summary,
}: {
  preview: NotificationEntry[];
  summary: NotificationSummary;
}) {
  const router = useRouter();
  const { toast } = useDialog();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // The poller publishes `health.updated` only when the visible set moves;
  // refresh the server-rendered props in place. Debounced against a burst.
  const lastRefreshAt = useRef<number>(0);
  useRealtimeEvent(
    (event) => event.type === "health.updated" || event.type === "realtime.reconnected",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  // Click outside closes; Escape closes and hands focus back to the bell so a
  // keyboard user isn't dropped at the top of the document.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setOpen(false);
      bellRef.current?.focus();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  const count = summary.active;
  const total = summary.active + summary.dismissed;
  const summaryText = summaryLine(summary);

  async function dismiss(entry: NotificationEntry) {
    setBusy(entryKey(entry));
    try {
      const outcome = await dismissNotificationIds(entryIds(entry));
      if (outcome.ok) {
        router.refresh();
        return;
      }
      toast({
        kind: "error",
        title:
          entry.kind === "group"
            ? "Could not dismiss the notifications"
            : "Could not dismiss the notification",
        description: outcome.error,
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={bellRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={bellLabel(summary)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="relative flex h-9 w-9 items-center justify-center rounded-md hover:bg-[color:var(--color-bg-subtle)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:outline-none"
      >
        <Bell aria-hidden className="h-5 w-5 text-[color:var(--color-fg-muted)]" />
        {count > 0 ? (
          <span
            aria-hidden
            className={`absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.6rem] font-semibold text-white tabular-nums ${
              summary.error > 0 ? "bg-[color:var(--color-error)]" : "bg-[color:var(--color-warn)]"
            }`}
          >
            {badgeCount(count)}
          </span>
        ) : null}
      </button>

      {open ? (
        // Mobile: pinned to the viewport with small gutters (the bell sits near
        // the right edge). sm+: anchored under the bell, wider again on lg.
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
          tabIndex={-1}
          className="fixed inset-x-3 top-14 z-20 mt-2 overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-bg)] shadow-lg outline-none sm:absolute sm:inset-x-auto sm:top-auto sm:right-0 sm:w-[26rem] lg:w-[30rem]"
        >
          <div className="flex items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold">Notifications</p>
              <p className="truncate text-xs text-[color:var(--color-fg-muted)]">
                {summaryText || "Nothing needs attention"}
              </p>
            </div>
            {total > 0 ? (
              <Link
                href="/notifications"
                onClick={() => setOpen(false)}
                className="shrink-0 text-xs font-medium text-[color:var(--color-accent)] hover:underline"
              >
                View all
              </Link>
            ) : null}
          </div>

          {preview.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <CheckCircle2 aria-hidden className="h-6 w-6 text-[color:var(--color-success)]" />
              <p className="text-sm font-medium">You&apos;re all caught up</p>
              {summary.dismissed > 0 ? (
                <p className="text-xs text-[color:var(--color-fg-muted)]">
                  {summary.dismissed} dismissed
                </p>
              ) : null}
            </div>
          ) : (
            <ul className="divide-y divide-[color:var(--color-border)]">
              {preview.map((entry) => (
                <li key={entryKey(entry)} className="px-4 py-3">
                  <BellEntry
                    entry={entry}
                    busy={busy === entryKey(entry)}
                    onNavigate={() => setOpen(false)}
                    onDismiss={() => void dismiss(entry)}
                  />
                </li>
              ))}
            </ul>
          )}

          {total > 0 ? (
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="flex items-center justify-center gap-1.5 border-t border-[color:var(--color-border)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-subtle)]"
            >
              Show all {total} notification{total === 1 ? "" : "s"}
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BellEntry({
  entry,
  busy,
  onNavigate,
  onDismiss,
}: {
  entry: NotificationEntry;
  busy: boolean;
  onNavigate: () => void;
  onDismiss: () => void;
}) {
  const v = entryView(entry);
  return (
    <div className="flex items-start gap-3">
      <span
        aria-hidden
        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${severityDotClass(v.severity)}`}
      />
      <div className="min-w-0 flex-1">
        <Link
          href={v.href}
          onClick={onNavigate}
          className="line-clamp-2 text-sm font-medium break-words hover:underline"
        >
          <span className="sr-only">{severityWord(v.severity)}: </span>
          {v.title}
        </Link>
        <p className="mt-0.5 line-clamp-2 text-xs break-words text-[color:var(--color-fg-muted)]">
          {v.detail}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[color:var(--color-fg-subtle)]">
          <span>{v.source}</span>
          {v.backendName ? <span className="font-mono">{v.backendName}</span> : null}
          <LocalTime ts={v.lastSeenAt} style="relative" />
          {v.fixHref ? (
            <Link
              href={v.fixHref}
              onClick={onNavigate}
              className="font-medium text-[color:var(--color-accent)] hover:underline"
            >
              Review and fix all
            </Link>
          ) : null}
          <button
            type="button"
            onClick={onDismiss}
            disabled={busy}
            className="ml-auto text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:underline disabled:opacity-50"
          >
            {busy ? "Dismissing…" : entry.kind === "group" ? "Dismiss all" : "Dismiss"}
            <span className="sr-only"> {v.title}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
