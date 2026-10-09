/**
 * lib/metrics/retention.ts
 *
 * Bounded-window retention for the three append-only tables the poller and
 * the PDNS transport write: `metric_samples`, `pdns_server_stats` and
 * `pdns_requests`. Anything older than the matching window is dead weight -
 * never queried, never displayed - so we drop it during the poll cycle that
 * follows.
 *
 * **The two metrics windows track the dashboard's display windows 1:1**,
 * sourced from `./dashboard-windows.ts`. Change a graph's window in one
 * place; retention follows automatically on the next tick. We keep nothing we
 * don't display.
 *
 * `pdns_requests` has no display window - the change-history feed shows the
 * rows that belong to an audit entry - so its window is an operator knob,
 * `PDNS_REQUEST_LOG_RETENTION_DAYS` (default 7). The poller alone writes
 * several rows per backend per minute (listZones every 30 s; stats, config,
 * autoprimaries and TSIG keys every 60 s), roughly 8k rows per backend per
 * day across three indexes, so an unbounded table was the single fastest-
 * growing thing in the database.
 *
 * Throttled to one DELETE sweep per 5 minutes via a module-scope last-run
 * timestamp. The sampler ticks every ~60s; running the deletes every tick
 * would be noise. 5 minutes is more than fast enough to keep the tables
 * from unbounded growth (the worst case is one cycle's writes survive an
 * extra 5 minutes - sub-percent of any window).
 */

import "server-only";
import { lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { metricSamples, pdnsRequests, pdnsServerStats } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  DASHBOARD_METRIC_SAMPLES_WINDOW_MS,
  DASHBOARD_PDNS_STATS_WINDOW_MS,
} from "./dashboard-windows";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention for `metric_samples`. Tracks the dashboard's read window 1:1. */
export const METRIC_SAMPLES_RETENTION_MS = DASHBOARD_METRIC_SAMPLES_WINDOW_MS;

/** Retention for `pdns_server_stats`. Tracks the dashboard's read window 1:1. */
export const PDNS_SERVER_STATS_RETENTION_MS = DASHBOARD_PDNS_STATS_WINDOW_MS;

/** Retention for `pdns_requests`, from `PDNS_REQUEST_LOG_RETENTION_DAYS`. */
export const PDNS_REQUESTS_RETENTION_MS = env.PDNS_REQUEST_LOG_RETENTION_DAYS * DAY_MS;

/** Minimum gap between consecutive prune runs. */
const PRUNE_THROTTLE_MS = 5 * 60 * 1000;

let lastPruneAtMs = 0;

/**
 * Best-effort retention sweep. Idempotent (running it twice in a row deletes
 * 0 rows on the second call). Caller should `void`-await: failures are
 * logged but never propagated - write-path latency must not depend on this.
 *
 * Returns true when a prune ran (used by tests; production callers ignore).
 */
export async function pruneOldSamples(now: Date = new Date()): Promise<boolean> {
  if (now.getTime() - lastPruneAtMs < PRUNE_THROTTLE_MS) return false;
  lastPruneAtMs = now.getTime();

  const sweeps = [
    {
      table: "metric_samples",
      run: () =>
        db
          .delete(metricSamples)
          .where(lt(metricSamples.sampledAt, cutoff(now, METRIC_SAMPLES_RETENTION_MS))),
    },
    {
      table: "pdns_server_stats",
      run: () =>
        db
          .delete(pdnsServerStats)
          .where(lt(pdnsServerStats.ts, cutoff(now, PDNS_SERVER_STATS_RETENTION_MS))),
    },
    {
      table: "pdns_requests",
      run: () =>
        db.delete(pdnsRequests).where(lt(pdnsRequests.ts, cutoff(now, PDNS_REQUESTS_RETENTION_MS))),
    },
  ];

  for (const sweep of sweeps) {
    try {
      await sweep.run();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        `metrics.retention.${sweep.table}.failed`,
      );
    }
  }
  return true;
}

function cutoff(now: Date, retentionMs: number): Date {
  return new Date(now.getTime() - retentionMs);
}

/** Test-only: reset the throttle so a fresh test starts at "due to run". */
export function _resetRetentionForTests(): void {
  lastPruneAtMs = 0;
}
