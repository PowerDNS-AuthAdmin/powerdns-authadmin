/**
 * lib/db/schema/metric-samples.ts
 *
 * Lightweight time-series of operational metrics - what the dashboard
 * charts read from. One row per (server, sampledAt) snapshot.
 *
 * Captured fields:
 *   - `zoneCount` - number of zones the PDNS API reports for this server.
 *   - `latencyP50Ms` / `latencyP95Ms` - request latency seen by our
 *     PdnsClient since the last sample.
 *   - `activeSessions` - sessions table count where !expired (a single
 *     row uses `serverId = null` for app-wide metrics - simpler than
 *     two tables for the same shape).
 *
 * The sampler in `lib/realtime/zone-poller.ts` writes rows from the poll cycle
 * (which any SSE subscriber or dashboard page load keeps running) rather than
 * via a standalone scheduler - keeps the data fresh enough for the dashboard
 * without a separate worker deployment. Real prod observability is
 * Prometheus's job.
 */

import {
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const metricSamples = pgTable(
  "metric_samples",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    /**
     * Backend this sample is for. `null` for app-wide samples (e.g. active
     * session count) that aren't backend-scoped.
     */
    serverId: uuid("server_id"),

    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),

    /** Number of zones on this backend at sample time. NULL on app-wide rows. */
    zoneCount: integer("zone_count"),

    /** Recent observed latency percentiles (ms). NULL when no observations. */
    latencyP50Ms: doublePrecision("latency_p50_ms"),
    latencyP95Ms: doublePrecision("latency_p95_ms"),

    /** Active session count app-wide. NULL on backend-scoped rows. */
    activeSessions: integer("active_sessions"),
  },
  (t) => ({
    serverTimeIdx: index("metric_samples_server_time_idx").on(t.serverId, t.sampledAt),
    timeIdx: index("metric_samples_time_idx").on(t.sampledAt),
  }),
);

export type MetricSample = typeof metricSamples.$inferSelect;
export type NewMetricSample = typeof metricSamples.$inferInsert;
