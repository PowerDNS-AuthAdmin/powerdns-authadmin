/**
 * lib/metrics/retention.ts
 *
 * Bounded-window retention for the two time-series tables the zone-poller
 * writes (`metric_samples`, `pdns_server_stats`). Anything older than the
 * matching window is dead weight — never queried, never displayed — so we
 * drop it during the poll cycle that follows.
 *
 * **The windows track the dashboard's display windows 1:1**, sourced from
 * `./dashboard-windows.ts`. Change a graph's window in one place; retention
 * follows automatically on the next tick. We keep nothing we don't display.
 *
 * Throttled to one DELETE pair per 5 minutes via a module-scope last-run
 * timestamp. The sampler ticks every ~60s; running the deletes every tick
 * would be noise. 5 minutes is more than fast enough to keep the tables
 * from unbounded growth (the worst case is one cycle's writes survive an
 * extra 5 minutes — sub-percent of either window).
 */

import "server-only";
import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { metricSamples, pdnsServerStats } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  DASHBOARD_METRIC_SAMPLES_WINDOW_MS,
  DASHBOARD_PDNS_STATS_WINDOW_MS,
} from "./dashboard-windows";

/** Retention for `metric_samples`. Tracks the dashboard's read window 1:1. */
export const METRIC_SAMPLES_RETENTION_MS = DASHBOARD_METRIC_SAMPLES_WINDOW_MS;

/** Retention for `pdns_server_stats`. Tracks the dashboard's read window 1:1. */
export const PDNS_SERVER_STATS_RETENTION_MS = DASHBOARD_PDNS_STATS_WINDOW_MS;

/** Minimum gap between consecutive prune runs. */
const PRUNE_THROTTLE_MS = 5 * 60 * 1000;

let lastPruneAtMs = 0;

/**
 * Best-effort retention sweep. Idempotent (running it twice in a row deletes
 * 0 rows on the second call). Caller should `void`-await: failures are
 * logged but never propagated — write-path latency must not depend on this.
 *
 * Returns true when a prune ran (used by tests; production callers ignore).
 */
export async function pruneOldSamples(now: Date = new Date()): Promise<boolean> {
  if (now.getTime() - lastPruneAtMs < PRUNE_THROTTLE_MS) return false;
  lastPruneAtMs = now.getTime();

  const metricCutoff = new Date(now.getTime() - METRIC_SAMPLES_RETENTION_MS);
  const statsCutoff = new Date(now.getTime() - PDNS_SERVER_STATS_RETENTION_MS);

  try {
    await db.delete(metricSamples).where(lt(metricSamples.sampledAt, metricCutoff));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "metrics.retention.metric_samples.failed",
    );
  }
  try {
    await db.delete(pdnsServerStats).where(lt(pdnsServerStats.ts, statsCutoff));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "metrics.retention.pdns_server_stats.failed",
    );
  }
  return true;
}

/** Test-only: reset the throttle so a fresh test starts at "due to run". */
export function _resetRetentionForTests(): void {
  lastPruneAtMs = 0;
}
