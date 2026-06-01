/**
 * lib/db/schema/pdns-server-stats.ts
 *
 * Time-series snapshots of PowerDNS `/statistics` output, one sample per
 * (server, timestamp, metric). The sampler runs every 60 s for each
 * active backend (primary + secondary). Most rows are plain numeric
 * counters; the few `MapStatisticItem` shapes (response-by-qtype,
 * response-by-rcode, response-sizes) are stored as JSONB.
 *
 * Counters in PDNS are cumulative since process start, so the dashboard
 * computes per-second/per-minute rates client-side by diffing consecutive
 * samples. A future-improvement might pre-compute deltas at write time,
 * but the table is small enough that on-read math stays cheap.
 *
 * Retention: not yet enforced. A periodic prune of rows older than
 * ~30 days will be wired in once volume becomes meaningful.
 */

import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pdnsServers } from "./pdns-servers";

export const pdnsServerStats = pgTable(
  "pdns_server_stats",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    serverId: uuid("server_id")
      .references(() => pdnsServers.id, { onDelete: "cascade" })
      .notNull(),
    /** Metric name from PDNS (`latency`, `udp4-queries`, `response-by-qtype`…). */
    name: text("name").notNull(),
    /**
     * Numeric counters land here. NULL when the metric is a Map shape;
     * `mapValue` carries the full structure in that case.
     */
    value: bigint("value", { mode: "number" }),
    /**
     * Map/ring metrics - array-of-objects with `name` / `value` pairs.
     * Used by `response-by-qtype`, `response-by-rcode`, `response-sizes`,
     * and the various `RingStatisticItem` rolling tops.
     */
    mapValue: jsonb("map_value").$type<Array<{ name: string; value: string }>>(),
  },
  (t) => ({
    serverTsIdx: index("pdns_server_stats_server_ts_idx").on(t.serverId, t.ts),
    serverNameTsIdx: index("pdns_server_stats_server_name_ts_idx").on(t.serverId, t.name, t.ts),
    tsIdx: index("pdns_server_stats_ts_idx").on(t.ts),
  }),
);

export type PdnsServerStatRow = typeof pdnsServerStats.$inferSelect;
export type NewPdnsServerStatRow = typeof pdnsServerStats.$inferInsert;
