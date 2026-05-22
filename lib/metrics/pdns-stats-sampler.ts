/**
 * lib/metrics/pdns-stats-sampler.ts
 *
 * Background sampler that polls `GET /statistics` from every active
 * PowerDNS backend (primary + secondary) and writes the result into
 * `pdns_server_stats`. The dashboard widgets + zone Statistics tab read
 * from the table; this module never reads.
 *
 * Cadence (60 s) is enforced by `ensureFreshPdnsStatsSample`: callers
 * invoke it lazily on page loads, and if the latest sample is older
 * than the threshold the sampler runs in the request scope. Skipping
 * the request scope (background timer) is fine for an MVP — PDNS HTTP
 * is cheap and one page-load per minute keeps the table fresh.
 *
 * Stat selection: we record EVERY `StatisticItem` (~100 numeric
 * counters — cheap), EVERY `MapStatisticItem` (3 small maps), and skip
 * the 10 `RingStatisticItem` rolling tops (large, low signal-to-noise
 * for time-series charts). The dashboards filter further at read time.
 */

import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { pdnsServerStats } from "@/lib/db/schema";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";

const DEFAULT_STALE_MS = 60 * 1000;

/** Run the sampler if the most recent sample is older than `staleMs`. */
export async function ensureFreshPdnsStatsSample(staleMs = DEFAULT_STALE_MS): Promise<number> {
  const latest = await db
    .select({ ts: pdnsServerStats.ts })
    .from(pdnsServerStats)
    .orderBy(desc(pdnsServerStats.ts))
    .limit(1);
  const last = latest[0]?.ts;
  if (last && Date.now() - new Date(last).getTime() < staleMs) return 0;
  return samplePdnsStatsNow();
}

/** Sample every active backend right now. Returns the number of rows inserted. */
export async function samplePdnsStatsNow(): Promise<number> {
  const backends = await listAllActiveBackends();
  if (backends.length === 0) return 0;
  const ts = new Date();

  const results = await Promise.all(
    backends.map(async (b) => {
      try {
        const client = getPdnsClientForRow(b);
        const stats = await client.statistics();
        return { backend: b, stats, error: null as string | null };
      } catch (err) {
        const message = err instanceof Error ? redact(err.message) : "unknown";
        logger.warn({ server: b.slug, error: message }, "pdns.stats.sample.failed");
        return {
          backend: b,
          stats: [] as Awaited<ReturnType<ReturnType<typeof getPdnsClientForRow>["statistics"]>>,
          error: message,
        };
      }
    }),
  );

  // Flatten into one insert. Each backend contributes ~100 rows.
  type Insert = typeof pdnsServerStats.$inferInsert;
  const rows: Insert[] = [];
  for (const r of results) {
    if (r.error || r.stats.length === 0) continue;
    for (const entry of r.stats) {
      if (entry.type === "StatisticItem") {
        const n = Number(entry.value);
        if (!Number.isFinite(n)) continue;
        rows.push({ ts, serverId: r.backend.id, name: entry.name, value: n });
      } else if (entry.type === "MapStatisticItem") {
        rows.push({
          ts,
          serverId: r.backend.id,
          name: entry.name,
          mapValue: entry.value,
        });
      }
      // RingStatisticItem entries deliberately skipped — high cardinality,
      // limited utility on the dashboards we're building.
    }
  }
  if (rows.length === 0) return 0;
  // Insert in chunks so a single statement doesn't slam the pool with a
  // 200-row payload. 100/insert keeps Postgres + our connection pool happy.
  const CHUNK = 100;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await db.insert(pdnsServerStats).values(slice);
    inserted += slice.length;
  }
  logger.info({ backends: backends.length, rows: inserted }, "pdns.stats.sample.ok");
  return inserted;
}

/**
 * Read the N most recent samples for one (server, metric) pair, oldest
 * first (suitable for plotting). The composite index on
 * `(server_id, name, ts)` makes this a cheap range scan.
 */
export async function readRecentMetric(
  serverId: string,
  name: string,
  limit = 120,
): Promise<Array<{ ts: Date; value: number | null; mapValue: unknown }>> {
  const rows = await db
    .select({
      ts: pdnsServerStats.ts,
      value: pdnsServerStats.value,
      mapValue: pdnsServerStats.mapValue,
    })
    .from(pdnsServerStats)
    .where(and(eq(pdnsServerStats.serverId, serverId), eq(pdnsServerStats.name, name)))
    .orderBy(desc(pdnsServerStats.ts))
    .limit(limit);
  return rows.reverse();
}

/**
 * Batched variant — fetch the N most recent samples for several metrics
 * for one server at once. Used by the dashboard widget that plots
 * many counters side by side without 10 round trips.
 */
export async function readRecentMetrics(
  serverId: string,
  names: readonly string[],
  limit = 120,
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
    .where(and(eq(pdnsServerStats.serverId, serverId), inArray(pdnsServerStats.name, [...names])))
    .orderBy(asc(pdnsServerStats.ts));
  const out = new Map<string, Array<{ ts: Date; value: number | null; mapValue: unknown }>>();
  for (const r of rows) {
    const list = out.get(r.name) ?? [];
    list.push({ ts: r.ts, value: r.value, mapValue: r.mapValue });
    out.set(r.name, list);
  }
  // Cap each list to the requested limit (keep the newest).
  for (const [k, list] of out) {
    if (list.length > limit) out.set(k, list.slice(list.length - limit));
  }
  return out;
}
