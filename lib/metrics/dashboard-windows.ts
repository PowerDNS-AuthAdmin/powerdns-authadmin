/**
 * lib/metrics/dashboard-windows.ts
 *
 * Single source of truth for "how far back does the dashboard look?" Each
 * graph picks the window it actually displays from here, and the retention
 * sweep (`lib/metrics/retention.ts`) reads the same values to delete anything
 * older. Change the window in one place; everywhere else tracks 1:1.
 *
 * Rule: we keep nothing we don't display. If a graph's window shrinks, the
 * retention sweep starts deleting more aggressively on the next tick. If it
 * grows, the next sample lives long enough to feed the wider query.
 */

/**
 * `metric_samples` window. Read by `backendSeries()` (zones per backend,
 * latency p50/p95) and `sessionsSeries()` (active sessions). 7 days matches
 * the dashboard's broad-trends panels.
 */
export const DASHBOARD_METRIC_SAMPLES_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * `pdns_server_stats` window. Read by `readRecentMetrics()` (per-backend
 * queries / cache hits / response sizes widgets on the backend-detail
 * card). 2 hours - the dashboard's "what's the daemon doing right now?"
 * view. Beyond that, the data isn't shown and is just bloating the table.
 */
export const DASHBOARD_PDNS_STATS_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * `audit_log` hourly buckets - read by `auditCountsPerHour()` (edits-per-
 * hour and logins-per-hour panels). 24 hours. Stored here for symmetry; the
 * audit table doesn't carry the same retention concern (audit rows persist
 * for compliance), so retention does NOT prune it.
 */
export const DASHBOARD_AUDIT_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Convenience: same window as hours, for repository helpers that take `hours`. */
export const DASHBOARD_METRIC_SAMPLES_WINDOW_HOURS = DASHBOARD_METRIC_SAMPLES_WINDOW_MS / 3_600_000;
export const DASHBOARD_AUDIT_HOURLY_WINDOW_HOURS = DASHBOARD_AUDIT_HOURLY_WINDOW_MS / 3_600_000;
