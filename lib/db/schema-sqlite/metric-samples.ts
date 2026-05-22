/**
 * lib/db/schema-sqlite/metric-samples.ts — SQLite mirror of `../schema/metric-samples.ts`.
 */

import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const metricSamples = sqliteTable(
  "metric_samples",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),
    serverId: text("server_id"),
    sampledAt: integer("sampled_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    zoneCount: integer("zone_count"),
    latencyP50Ms: real("latency_p50_ms"),
    latencyP95Ms: real("latency_p95_ms"),
    activeSessions: integer("active_sessions"),
  },
  (t) => ({
    serverTimeIdx: index("metric_samples_server_time_idx").on(t.serverId, t.sampledAt),
    timeIdx: index("metric_samples_time_idx").on(t.sampledAt),
  }),
);

export type MetricSample = typeof metricSamples.$inferSelect;
export type NewMetricSample = typeof metricSamples.$inferInsert;
