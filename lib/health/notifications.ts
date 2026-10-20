/**
 * lib/health/notifications.ts
 *
 * The notification list behind the header bell and the Notifications page:
 * backend-health advisories (ADR-0015) and zone-monitoring findings, which
 * share the `backend_advisories` table. Pure, so the bell, the page, the
 * dismiss route and MCP all apply one visibility rule.
 *
 * Visibility is per row, not per audience. A backend advisory needs
 * `server.read`. A zone-monitoring advisory names a zone, so it needs
 * `zone.read` on that zone on that backend: a user granted one zone must not
 * learn the names, let alone the problems, of every other zone in the fleet.
 */

import { MONITOR_CODE_PREFIXES } from "@/lib/health/evaluator";

export type NotificationSeverity = "error" | "warn" | "info";
export type NotificationSource = "backend" | "zone";

export interface AdvisoryRow {
  id: string;
  backendId: string;
  backendName: string;
  backendSlug: string;
  code: string;
  severity: string;
  title: string;
  detail: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  acknowledgedAt: Date | null;
}

export interface AppNotification {
  id: string;
  severity: NotificationSeverity;
  source: NotificationSource;
  title: string;
  detail: string;
  backendId: string;
  backendName: string;
  backendSlug: string;
  /** The zone a monitoring finding is about; null for backend health. */
  zone: string | null;
  /** Where the operator acts on it. */
  href: string;
  firstSeenAt: string;
  lastSeenAt: string;
  acknowledged: boolean;
}

export interface NotificationSummary {
  /** Not yet dismissed. */
  active: number;
  error: number;
  warn: number;
  info: number;
  dismissed: number;
}

export interface NotificationViewer {
  /** `server.read` at any scope: the audience for backend health. */
  canReadServers: boolean;
  /** `zone.read` on this zone on this backend (global or through a grant). */
  canReadZone: (serverId: string, zone: string) => boolean;
  /** Global `zone.read`: needed for a monitoring row whose zone cannot be parsed. */
  globalZoneRead: boolean;
}

export function isMonitorCode(code: string): boolean {
  return MONITOR_CODE_PREFIXES.some((p) => code.startsWith(p));
}

/**
 * The zone in a monitoring advisory code. Codes are `monitor.<zone><finding>`
 * where the zone is absolute (ends with a dot) and the finding starts with
 * one, so the first `..` marks the boundary: `monitor.example.com..soa.mname`.
 */
export function monitorZoneOf(code: string): string | null {
  const prefix = MONITOR_CODE_PREFIXES.find((p) => code.startsWith(p));
  if (!prefix) return null;
  const rest = code.slice(prefix.length);
  if (rest.startsWith("..")) return ".";
  const boundary = rest.indexOf("..");
  if (boundary <= 0) return null;
  return rest.slice(0, boundary + 1);
}

export function canSeeAdvisory(
  row: Pick<AdvisoryRow, "code" | "backendId">,
  viewer: NotificationViewer,
): boolean {
  if (!isMonitorCode(row.code)) return viewer.canReadServers;
  const zone = monitorZoneOf(row.code);
  if (!zone) return viewer.globalZoneRead;
  return viewer.canReadZone(row.backendId, zone);
}

function severityOf(s: string): NotificationSeverity {
  return s === "error" || s === "warn" ? s : "info";
}

const SEVERITY_RANK: Record<NotificationSeverity, number> = { error: 0, warn: 1, info: 2 };

export function toNotification(row: AdvisoryRow): AppNotification {
  const zone = isMonitorCode(row.code) ? monitorZoneOf(row.code) : null;
  return {
    id: row.id,
    severity: severityOf(row.severity),
    source: zone !== null || isMonitorCode(row.code) ? "zone" : "backend",
    title: row.title,
    detail: row.detail,
    backendId: row.backendId,
    backendName: row.backendName,
    backendSlug: row.backendSlug,
    zone,
    href: isMonitorCode(row.code) ? "/zones/monitoring" : `/admin/servers/${row.backendId}`,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    acknowledged: row.acknowledgedAt !== null,
  };
}

/** Active before dismissed, then errors first, then the most recently seen. */
export function compareNotifications(a: AppNotification, b: AppNotification): number {
  if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
  const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  if (s !== 0) return s;
  return b.lastSeenAt.localeCompare(a.lastSeenAt);
}

export function visibleNotifications(
  rows: readonly AdvisoryRow[],
  viewer: NotificationViewer,
): AppNotification[] {
  return rows
    .filter((r) => canSeeAdvisory(r, viewer))
    .map(toNotification)
    .sort(compareNotifications);
}

export function summarizeNotifications(list: readonly AppNotification[]): NotificationSummary {
  const out: NotificationSummary = { active: 0, error: 0, warn: 0, info: 0, dismissed: 0 };
  for (const n of list) {
    if (n.acknowledged) {
      out.dismissed++;
      continue;
    }
    out.active++;
    out[n.severity]++;
  }
  return out;
}

/** What the bell shows: the few most pressing active notifications. */
export const BELL_PREVIEW_LIMIT = 3;

export function bellPreview(
  list: readonly AppNotification[],
  limit = BELL_PREVIEW_LIMIT,
): AppNotification[] {
  return list.filter((n) => !n.acknowledged).slice(0, limit);
}
