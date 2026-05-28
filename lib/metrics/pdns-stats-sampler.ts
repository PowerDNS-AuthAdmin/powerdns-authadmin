/**
 * lib/metrics/pdns-stats-sampler.ts
 *
 * Reader for the `pdns_server_stats` time-series. The dashboard widgets + zone
 * Statistics tab read from here.
 *
 * NOTE: the *sampling* (polling `GET /statistics` from every backend) now lives
 * in the app-wide broker poll (`lib/realtime/zone-poller.ts`, 60 s cadence) — so
 * all PDNS reads go through one place. This module is read-only.
 */

import "server-only";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pdnsServerStats } from "@/lib/db/schema";

/**
 * Fetch recent samples for several metrics for one server at once. Used by
 * the dashboard widget that plots many counters side by side without N
 * round trips. The composite index on `(server_id, name, ts)` keeps this a
 * cheap range scan.
 *
 * The window is bounded by `since` — the dashboard passes
 * `Date.now() - DASHBOARD_PDNS_STATS_WINDOW_MS`, which is the same window
 * the retention sweep deletes against. 1:1 link: we read only what we keep,
 * we keep only what we read.
 */
export async function readRecentMetrics(
  serverId: string,
  names: readonly string[],
  since: Date,
): Promise<Map<string, Array<{ ts: Date; value: number | null; mapValue: unknown }>>> {
  if (names.length === 0) return new Map();
  const rows = await db
    .select({
      ts: pdnsServerStats.ts,
      value: pdnsServerStats.value,
      mapValue: pdnsServerStats.mapValue,
      name: pdnsServerStats.name,
    })
    .from(pdnsServerStats)
    .where(
      and(
        eq(pdnsServerStats.serverId, serverId),
        inArray(pdnsServerStats.name, [...names]),
        gte(pdnsServerStats.ts, since),
      ),
    )
    .orderBy(asc(pdnsServerStats.ts));
  const out = new Map<string, Array<{ ts: Date; value: number | null; mapValue: unknown }>>();
  for (const r of rows) {
    const list = out.get(r.name) ?? [];
    list.push({ ts: r.ts, value: r.value, mapValue: r.mapValue });
    out.set(r.name, list);
  }
  return out;
}
