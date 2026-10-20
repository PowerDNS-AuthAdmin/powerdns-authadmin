/**
 * components/domain/notification-format.ts
 *
 * Presentation helpers shared by the header bell and the Notifications page.
 * Pure, so the copy and colour rules are unit-tested once.
 */

import type { NotificationSeverity, NotificationSummary } from "@/lib/health/notifications";

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
