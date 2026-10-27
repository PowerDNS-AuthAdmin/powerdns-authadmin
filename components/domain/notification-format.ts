/**
 * components/domain/notification-format.ts
 *
 * Presentation helpers shared by the header bell and the Notifications page.
 * Pure, so the copy and colour rules are unit-tested once.
 */

import {
  entryKey,
  type NotificationEntry,
  type NotificationSeverity,
  type NotificationSummary,
} from "@/lib/health/notifications";

export function severityDotClass(severity: NotificationSeverity): string {
  if (severity === "error") return "bg-[color:var(--color-error)]";
  if (severity === "warn") return "bg-[color:var(--color-warn)]";
  return "bg-[color:var(--color-fg-muted)]";
}

/** The dot's colour, spelled out for people who can't see it. */
export function severityWord(severity: NotificationSeverity): string {
  if (severity === "error") return "Error";
  if (severity === "warn") return "Warning";
  return "Info";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2 errors, 41 warnings" - the bell's summary line; empty when nothing is active. */
export function summaryLine(s: NotificationSummary): string {
  const parts: string[] = [];
  if (s.error) parts.push(plural(s.error, "error", "errors"));
  if (s.warn) parts.push(plural(s.warn, "warning", "warnings"));
  if (s.info) parts.push(plural(s.info, "notice", "notices"));
  return parts.join(", ");
}

/** The badge never grows past three characters. */
export function badgeCount(n: number): string {
  return n > 99 ? "99+" : String(n);
}

/** The bell's accessible name carries the count the badge shows visually. */
export function bellLabel(s: NotificationSummary): string {
  if (s.active === 0) return "Notifications: none active";
  return `Notifications: ${plural(s.active, "active", "active")}${s.error ? `, ${plural(s.error, "error", "errors")}` : ""}`;
}

/**
 * The zones behind a grouped finding, for one line under its title:
 * "a.example., b.example., c.example. and 114 more". A zone served by two
 * backends is named once.
 */
export function groupZoneSample(zones: ReadonlyArray<string | null>, shown = 3): string {
  const unique = [...new Set(zones.filter((z): z is string => z !== null))];
  const head = unique.slice(0, shown).join(", ");
  const rest = unique.length - shown;
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/** "117 zones" or "117 zones on 2 backends". */
export function groupScope(
  members: ReadonlyArray<{ zone: string | null; backendId: string }>,
): string {
  const zones = new Set(members.map((m) => m.zone)).size;
  const backends = new Set(members.map((m) => m.backendId)).size;
  const base = plural(zones, "zone", "zones");
  return backends > 1 ? `${base} on ${plural(backends, "backend", "backends")}` : base;
}

/** What a bell row or a Notifications row shows, for a single finding or a group. */
export interface EntryView {
  key: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
  href: string;
  /** Zone Monitoring's bulk fix for a grouped finding. */
  fixHref: string | null;
  source: string;
  /** Null for a group: its members may sit on several backends. */
  backendName: string | null;
  lastSeenAt: string;
  acknowledged: boolean;
}

export function entryView(entry: NotificationEntry): EntryView {
  if (entry.kind === "single") {
    const n = entry.notification;
    return {
      key: entryKey(entry),
      severity: n.severity,
      title: n.title,
      detail: n.detail,
      href: n.href,
      fixHref: null,
      source: n.source === "zone" ? "Zone monitoring" : "Backend health",
      backendName: n.backendName,
      lastSeenAt: n.lastSeenAt,
      acknowledged: n.acknowledged,
    };
  }
  return {
    key: entryKey(entry),
    severity: entry.severity,
    title: `${entry.title}, ${groupScope(entry.members)}`,
    detail: groupZoneSample(entry.members.map((m) => m.zone)),
    href: entry.href,
    fixHref: entry.fixHref,
    source: "Zone monitoring",
    backendName: null,
    lastSeenAt: entry.lastSeenAt,
    acknowledged: entry.acknowledged,
  };
}
