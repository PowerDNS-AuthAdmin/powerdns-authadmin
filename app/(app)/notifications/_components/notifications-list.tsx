"use client";

/**
 * The Notifications page body: filter chips, a searchable table with one
 * chevron accordion for the detail, and dismissal per row or for everything
 * currently shown. Filters apply per finding; what passes is then grouped, so
 * one finding on many zones is one row whose detail lists the zones and links
 * to Zone Monitoring's bulk fix where there is one. Data arrives as server props and is refreshed in place on
 * `health.updated` (and after a realtime reconnect), so filters, search and
 * the open row survive every update.
 */

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ColumnDef } from "@tanstack/react-table";
import {
  entryIds,
  entryKey,
  groupNotifications,
  type AppNotification,
  type NotificationEntry,
  type NotificationGroup,
  type NotificationSeverity,
} from "@/lib/health/notifications";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import {
  DisclosureChevron,
  RowDisclosurePanel,
  rowDetailId,
  useRowDisclosure,
} from "@/components/ui/row-disclosure";
import { ToggleChip, type ToggleChipTone } from "@/components/ui/toggle-chip";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { dismissNotificationIds } from "@/components/domain/notification-dismiss";
import { entryView, severityDotClass, severityWord } from "@/components/domain/notification-format";

type StatusFilter = "active" | "dismissed" | "all";
type SourceFilter = "backend" | "zone";

const SEVERITIES: ReadonlyArray<{
  key: NotificationSeverity;
  label: string;
  tone: ToggleChipTone;
}> = [
  { key: "error", label: "Errors", tone: "error" },
  { key: "warn", label: "Warnings", tone: "warn" },
  { key: "info", label: "Notices", tone: "muted" },
];

const SOURCES: ReadonlyArray<{ key: SourceFilter; label: string }> = [
  { key: "backend", label: "Backend health" },
  { key: "zone", label: "Zone monitoring" },
];

const STATUSES: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: "active", label: "Active" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

const PANEL_PREFIX = "notification";
const SEVERITY_RANK: Record<NotificationSeverity, number> = { error: 0, warn: 1, info: 2 };

function sourceLabel(n: AppNotification): string {
  return n.source === "zone" ? "Zone monitoring" : "Backend health";
}

function zoneHref(n: AppNotification): string | null {
  if (!n.zone) return null;
  return `/zones/${encodeURIComponent(n.zone)}?server=${encodeURIComponent(n.backendSlug)}`;
}

export function NotificationsList({ notifications }: { notifications: AppNotification[] }) {
  const router = useRouter();
  const { confirm, toast } = useDialog();
  const details = useRowDisclosure();
  const [status, setStatus] = useState<StatusFilter>("active");
  const [severities, setSeverities] = useState<ReadonlySet<NotificationSeverity>>(new Set());
  const [sources, setSources] = useState<ReadonlySet<SourceFilter>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  const lastRefreshAt = useRef(0);
  useRealtimeEvent(
    (event) => event.type === "health.updated" || event.type === "realtime.reconnected",
    () => {
      const now = Date.now();
      if (now - lastRefreshAt.current < 500) return;
      lastRefreshAt.current = now;
      router.refresh();
    },
  );

  const byStatus = useMemo(
    () =>
      notifications.filter((n) =>
        status === "all" ? true : status === "active" ? !n.acknowledged : n.acknowledged,
      ),
    [notifications, status],
  );

  // Chip counts follow the other filters, so each chip says what clicking it would show.
  const severityCounts = useMemo(() => {
    const c: Record<NotificationSeverity, number> = { error: 0, warn: 0, info: 0 };
    for (const n of byStatus) if (sources.size === 0 || sources.has(n.source)) c[n.severity]++;
    return c;
  }, [byStatus, sources]);
  const sourceCounts = useMemo(() => {
    const c: Record<SourceFilter, number> = { backend: 0, zone: 0 };
    for (const n of byStatus)
      if (severities.size === 0 || severities.has(n.severity)) c[n.source]++;
    return c;
  }, [byStatus, severities]);
  const statusCounts = useMemo(() => {
    const dismissed = notifications.filter((n) => n.acknowledged).length;
    return { active: notifications.length - dismissed, dismissed, all: notifications.length };
  }, [notifications]);

  const shown = useMemo(
    () =>
      byStatus.filter(
        (n) =>
          (severities.size === 0 || severities.has(n.severity)) &&
          (sources.size === 0 || sources.has(n.source)),
      ),
    [byStatus, severities, sources],
  );
  const rows = useMemo(() => groupNotifications(shown), [shown]);
  const dismissableShown = shown.filter((n) => !n.acknowledged);

  function toggle<T>(set: ReadonlySet<T>, key: T): Set<T> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  }

  async function dismiss(ids: string[], label: string, busyKey: string) {
    setBusy(busyKey);
    try {
      const outcome = await dismissNotificationIds(ids);
      if (!outcome.ok) {
        toast({ kind: "error", title: `Could not dismiss ${label}`, description: outcome.error });
        return;
      }
      if (ids.length > 1) {
        const n = outcome.dismissed;
        toast({
          kind: "success",
          title: `Dismissed ${n} notification${n === 1 ? "" : "s"}`,
          description: "They return if their condition changes or comes back.",
        });
      }
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function dismissShown() {
    const ids = dismissableShown.map((n) => n.id);
    if (ids.length === 0) return;
    const ok = await confirm({
      title: `Dismiss ${ids.length} notification${ids.length === 1 ? "" : "s"}?`,
      description:
        "They leave the bell and this list's Active view. Any that change or come back after clearing will notify again.",
      confirmLabel: "Dismiss",
    });
    if (ok) await dismiss(ids, "the notifications", "bulk");
  }

  const columns = useMemo<Array<ColumnDef<NotificationEntry, unknown>>>(
    () => [
      {
        id: "notification",
        // A group is found by any of its zones, not only the few named in its summary.
        accessorFn: (e) => {
          const v = entryView(e);
          const zones = e.kind === "group" ? e.members.map((m) => m.zone).join(" ") : "";
          return `${v.title} ${v.detail} ${zones} ${v.backendName ?? ""}`;
        },
        header: "Notification",
        sortingFn: (a, b) => {
          const va = entryView(a.original);
          const vb = entryView(b.original);
          return (
            SEVERITY_RANK[va.severity] - SEVERITY_RANK[vb.severity] ||
            va.title.localeCompare(vb.title)
          );
        },
        meta: { className: "md:w-[55%]" },
        cell: ({ row }) => {
          const v = entryView(row.original);
          return (
            <span className="flex min-w-0 items-start gap-2">
              <DisclosureChevron
                open={details.isOpen(v.key)}
                onToggle={() => details.toggle(v.key)}
                label={v.title}
                controls={rowDetailId(PANEL_PREFIX, v.key)}
              />
              <span
                aria-hidden
                className={`mt-2 h-2 w-2 shrink-0 rounded-full ${severityDotClass(v.severity)}`}
              />
              <span className="min-w-0">
                <Link
                  href={v.href}
                  className={`text-sm font-medium break-words hover:underline ${v.acknowledged ? "text-[color:var(--color-fg-muted)]" : ""}`}
                >
                  <span className="sr-only">{severityWord(v.severity)}: </span>
                  {v.title}
                </Link>
                <span className="mt-0.5 line-clamp-1 block text-xs break-words text-[color:var(--color-fg-muted)]">
                  {v.detail}
                </span>
              </span>
            </span>
          );
        },
      },
      {
        id: "source",
        accessorFn: (e) => {
          const v = entryView(e);
          return `${v.source} ${v.backendName ?? ""}`;
        },
        header: "Source",
        cell: ({ row }) => {
          const v = entryView(row.original);
          return (
            <span className="text-xs">
              <span className="block">{v.source}</span>
              {v.backendName ? (
                <span className="block font-mono text-[color:var(--color-fg-muted)]">
                  {v.backendName}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "lastSeen",
        accessorFn: (e) => entryView(e).lastSeenAt,
        header: "Last seen",
        cell: ({ row }) => (
          <LocalTime ts={entryView(row.original).lastSeenAt} style="relative" className="text-xs" />
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        meta: { className: "text-right" },
        cell: ({ row }) => {
          const e = row.original;
          const v = entryView(e);
          if (v.acknowledged) {
            return <span className="text-xs text-[color:var(--color-fg-subtle)]">Dismissed</span>;
          }
          const group = e.kind === "group";
          return (
            <button
              type="button"
              onClick={() =>
                void dismiss(
                  entryIds(e),
                  group ? "the notifications" : "the notification",
                  entryKey(e),
                )
              }
              disabled={busy !== null}
              className="rounded-md border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50"
            >
              {busy === v.key ? "Dismissing…" : group ? "Dismiss all" : "Dismiss"}
              <span className="sr-only"> {v.title}</span>
            </button>
          );
        },
      },
    ],
    // `dismiss` closes over state that `busy` already tracks for re-rendering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [details, busy],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Status"
            className="inline-flex overflow-hidden rounded-md border border-[color:var(--color-border)]"
          >
            {STATUSES.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={status === s.key}
                onClick={() => setStatus(s.key)}
                className={`px-3 py-1.5 text-xs font-medium ${
                  status === s.key
                    ? "bg-[color:var(--color-bg-subtle)] text-[color:var(--color-fg)]"
                    : "text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
                }`}
              >
                {s.label} <span className="tabular-nums">{statusCounts[s.key]}</span>
              </button>
            ))}
          </div>
          <span aria-hidden className="hidden h-5 w-px bg-[color:var(--color-border)] sm:block" />
          <div role="group" aria-label="Severity" className="flex flex-wrap gap-2">
            {SEVERITIES.map((s) => (
              <ToggleChip
                key={s.key}
                active={severities.has(s.key)}
                tone={s.tone}
                title={`Show only ${s.label.toLowerCase()}`}
                count={severityCounts[s.key]}
                onClick={() => setSeverities((cur) => toggle(cur, s.key))}
              >
                {s.label}
              </ToggleChip>
            ))}
          </div>
          <div role="group" aria-label="Source" className="flex flex-wrap gap-2">
            {SOURCES.map((s) => (
              <ToggleChip
                key={s.key}
                active={sources.has(s.key)}
                tone="accent"
                title={`Show only ${s.label.toLowerCase()}`}
                count={sourceCounts[s.key]}
                onClick={() => setSources((cur) => toggle(cur, s.key))}
              >
                {s.label}
              </ToggleChip>
            ))}
          </div>
        </div>
        {dismissableShown.length > 0 ? (
          <button
            type="button"
            onClick={() => void dismissShown()}
            disabled={busy !== null}
            className="self-start rounded-md border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-bg-subtle)] disabled:opacity-50 lg:self-auto"
          >
            {busy === "bulk" ? "Dismissing…" : `Dismiss ${dismissableShown.length} shown`}
          </button>
        ) : null}
      </div>

      <DataTable
        columns={columns}
        data={rows}
        searchPlaceholder="Search notifications…"
        pageSize={25}
        initialSort={[{ id: "lastSeen", desc: true }]}
        stateKey="notifications"
        noDataMessage={
          notifications.length === 0
            ? "Nothing to report. Backend health and zone monitoring are clear."
            : status === "active" && statusCounts.active === 0
              ? "You're all caught up."
              : "No notifications match the selected filters."
        }
        renderRowDetail={(e) => {
          const v = entryView(e);
          return details.isOpen(v.key) ? (
            <RowDisclosurePanel
              id={rowDetailId(PANEL_PREFIX, v.key)}
              label={`Details for ${v.title}`}
            >
              {e.kind === "group" ? (
                <GroupDetail group={e} />
              ) : (
                <NotificationDetail n={e.notification} />
              )}
            </RowDisclosurePanel>
          ) : null;
        }}
      />
    </div>
  );
}

function NotificationDetail({ n }: { n: AppNotification }) {
  const zone = zoneHref(n);
  return (
    <div className="grid gap-4 pt-3 text-sm lg:grid-cols-3">
      <p className="break-words whitespace-pre-line lg:col-span-2">{n.detail}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-[color:var(--color-fg-muted)]">Severity</dt>
        <dd>{severityWord(n.severity)}</dd>
        <dt className="text-[color:var(--color-fg-muted)]">Source</dt>
        <dd>{sourceLabel(n)}</dd>
        <dt className="text-[color:var(--color-fg-muted)]">Backend</dt>
        <dd className="font-mono break-all">{n.backendName}</dd>
        {n.zone ? (
          <>
            <dt className="text-[color:var(--color-fg-muted)]">Zone</dt>
            <dd className="font-mono break-all">
              {zone ? (
                <Link href={zone} className="text-[color:var(--color-accent)] hover:underline">
                  {n.zone}
                </Link>
              ) : (
                n.zone
              )}
            </dd>
          </>
        ) : null}
        <dt className="text-[color:var(--color-fg-muted)]">First seen</dt>
        <dd>
          <LocalTime ts={n.firstSeenAt} />
        </dd>
        <dt className="text-[color:var(--color-fg-muted)]">Last seen</dt>
        <dd>
          <LocalTime ts={n.lastSeenAt} />
        </dd>
      </dl>
      <div className="lg:col-span-3">
        <Link href={n.href} className="text-sm text-[color:var(--color-accent)] hover:underline">
          {n.source === "zone" ? "Open Zone Monitoring" : "Open the backend"}
        </Link>
      </div>
    </div>
  );
}

/** Above this many zones the detail shows the first ones and says how many more. */
const GROUP_DETAIL_LIMIT = 50;

function GroupDetail({ group }: { group: NotificationGroup }) {
  const shown = group.members.slice(0, GROUP_DETAIL_LIMIT);
  const more = group.members.length - shown.length;
  const sample = group.members[0]!;
  return (
    <div className="space-y-3 pt-3 text-sm">
      <p className="text-xs text-[color:var(--color-fg-muted)]">
        <code className="font-mono">{group.finding}</code> on {group.members.length} zones. For{" "}
        <span className="font-mono">{sample.zone}</span>: {sample.detail}
      </p>
      <ul className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((m) => {
          const href = zoneHref(m);
          return (
            <li key={m.id} className="flex min-w-0 items-baseline gap-2">
              {href ? (
                <Link
                  href={href}
                  className="min-w-0 font-mono break-all text-[color:var(--color-accent)] hover:underline"
                >
                  {m.zone}
                </Link>
              ) : (
                <span className="min-w-0 font-mono break-all">{m.zone}</span>
              )}
              <span className="shrink-0 font-mono text-[color:var(--color-fg-muted)]">
                {m.backendName}
              </span>
            </li>
          );
        })}
      </ul>
      {more > 0 ? (
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          and {more} more; search by zone name to find one.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {group.fixHref ? (
          <Link
            href={group.fixHref}
            className="text-sm font-medium text-[color:var(--color-accent)] hover:underline"
          >
            Review and fix all on Zone Monitoring
          </Link>
        ) : null}
        <Link
          href={group.href}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          Open Zone Monitoring
        </Link>
      </div>
    </div>
  );
}
