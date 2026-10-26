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
  /** The monitoring finding's code (`soa.mname`); null for backend health. */
  finding: string | null;
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
  /** Global `server.read`: the audience for backend health. */
  canReadServers: boolean;
  /** `zone.read` on this zone on this backend (`canActOnZone`: global, grant or zone-scoped role). */
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
    finding: zone === null ? null : monitorFindingOf(row.code),
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

/**
 * The finding in a monitoring advisory code: `soa.mname` for
 * `monitor.example.com..soa.mname`. Null for backend codes and for codes
 * whose zone cannot be parsed.
 */
export function monitorFindingOf(code: string): string | null {
  const zone = monitorZoneOf(code);
  if (zone === null) return null;
  const prefix = MONITOR_CODE_PREFIXES.find((p) => code.startsWith(p)) ?? "";
  // The zone keeps its trailing dot; the finding starts after the boundary dot.
  return code.slice(prefix.length + zone.length + 1) || null;
}

/**
 * Findings with a fix that can be applied to many zones at once from Zone
 * Monitoring, keyed by finding code. The value is the `?fix=` the page opens.
 */
const BULK_FIXABLE_FINDINGS: Readonly<Record<string, string>> = { "soa.mname": "soa.mname" };

/** One finding on many zones, shown as a single entry. */
export interface NotificationGroup {
  kind: "group";
  /** Stable across refreshes: the finding, severity and dismissed state. */
  key: string;
  severity: NotificationSeverity;
  /** The finding code, e.g. `soa.mname`. */
  finding: string;
  /** The finding's title without a zone, e.g. "SOA MNAME is not one of the nameservers". */
  title: string;
  /** Most recently seen first. */
  members: AppNotification[];
  href: string;
  /** Zone Monitoring's bulk fix for this finding, when there is one. */
  fixHref: string | null;
  lastSeenAt: string;
  acknowledged: boolean;
}

export type NotificationEntry =
  | { kind: "single"; notification: AppNotification }
  | NotificationGroup;

/** Below this many zones a finding stays as separate rows. */
export const GROUP_MIN_MEMBERS = 2;

/**
 * The finding's title without the zone in front. Monitoring titles are
 * `<zone> <title>`, or `<zone> (internal) <title>` for the internal copy of a
 * split-horizon zone (see `advisoriesFor` in lib/monitoring/zone-monitor.ts).
 */
function findingTitle(n: AppNotification): string {
  if (!n.zone || !n.title.startsWith(n.zone)) return n.title;
  return n.title
    .slice(n.zone.length)
    .replace(/^ \(internal\)/, "")
    .trim();
}

/**
 * Collapses zone-monitoring findings that share a code, a severity and a
 * dismissed state into one entry ("SOA MNAME is not one of the nameservers,
 * 117 zones"). Backend health and findings seen on a single zone stay as they
 * are. Order follows the input: a group sits where its first member was, so a
 * list sorted by `compareNotifications` stays sorted.
 */
export function groupNotifications(
  list: readonly AppNotification[],
  minMembers = GROUP_MIN_MEMBERS,
): NotificationEntry[] {
  const groups = new Map<string, NotificationGroup>();
  const slots: Array<{ single: AppNotification } | { groupKey: string }> = [];
  for (const n of list) {
    const finding = n.finding;
    if (finding === null) {
      slots.push({ single: n });
      continue;
    }
    const key = `${finding}|${n.severity}|${n.acknowledged ? "dismissed" : "active"}`;
    const group = groups.get(key);
    if (group) {
      group.members.push(n);
      continue;
    }
    const fix = BULK_FIXABLE_FINDINGS[finding];
    groups.set(key, {
      kind: "group",
      key,
      severity: n.severity,
      finding,
      title: findingTitle(n),
      members: [n],
      href: n.href,
      fixHref: fix ? `/zones/monitoring?fix=${encodeURIComponent(fix)}` : null,
      lastSeenAt: n.lastSeenAt,
      acknowledged: n.acknowledged,
    });
    slots.push({ groupKey: key });
  }
  const out: NotificationEntry[] = [];
  for (const slot of slots) {
    if ("single" in slot) {
      out.push({ kind: "single", notification: slot.single });
      continue;
    }
    const group = groups.get(slot.groupKey)!;
    if (group.members.length < minMembers) {
      for (const m of group.members) out.push({ kind: "single", notification: m });
      continue;
    }
    group.members.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
    group.lastSeenAt = group.members[0]!.lastSeenAt;
    out.push(group);
  }
  return out;
}

export function entryKey(entry: NotificationEntry): string {
  return entry.kind === "single" ? entry.notification.id : entry.key;
}

/** Every notification id behind an entry: one for a single, all members for a group. */
export function entryIds(entry: NotificationEntry): string[] {
  return entry.kind === "single" ? [entry.notification.id] : entry.members.map((m) => m.id);
}

/** What the bell shows: the few most pressing active entries, identical findings grouped. */
export const BELL_PREVIEW_LIMIT = 3;

export function bellPreview(
  list: readonly AppNotification[],
  limit = BELL_PREVIEW_LIMIT,
): NotificationEntry[] {
  return groupNotifications(list.filter((n) => !n.acknowledged)).slice(0, limit);
}
