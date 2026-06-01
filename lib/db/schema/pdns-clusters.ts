/**
 * lib/db/schema/pdns-clusters.ts
 *
 * Multi-primary peer groups. A cluster is a set of PDNS backends whose
 * underlying storage replicates between them (Galera, Postgres logical
 * replication, etc.) - every peer is writable, and a write to any one of
 * them propagates to the rest via the backend.
 *
 * The app's only job is to pick ONE peer per write (per the
 * `write_strategy`) and then track sync state until all peers report the
 * same serial. The post-write "expected serial" source-of-truth used by
 * `lib/pdns/cluster-sync.ts` is an in-memory cache keyed on (cluster_id,
 * zone_name) - that's not persisted here; the row below carries only the
 * cluster identity + write-routing policy.
 *
 * Standalone primaries and primary+secondaries setups don't touch this
 * table at all - `pdns_servers.cluster_id` stays NULL.
 */

import { pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

/**
 * How the app picks which peer to send the next write to. All strategies
 * operate over `cluster_id`'s active (non-disabled) members.
 *
 *   round_robin    - rotate through peers in order. Cluster-level state
 *                    lives in-process and resets on app boot; the
 *                    semantics are good-enough load-balancing, not strict
 *                    fairness. Cheapest to implement, no DB read.
 *   lowest_latency - pick the peer with the lowest recent observed
 *                    request latency from `pdns_server_stats`.
 *   random         - uniform random.
 *   least_load     - pick the peer with the lowest recent zone count
 *                    (proxy for "least busy"); falls back to random when
 *                    we have no samples yet.
 */
export const pdnsClusterWriteStrategyEnum = pgEnum("pdns_cluster_write_strategy", [
  "round_robin",
  "lowest_latency",
  "random",
  "least_load",
]);

export const pdnsClusters = pgTable("pdns_clusters", {
  id: pk(),

  /** URL-safe slug - appears in /admin/clusters/<slug> and in
   *  provisioning YAML `cluster_slug` references. */
  slug: text("slug").notNull().unique(),

  /** Display name. */
  name: text("name").notNull(),

  /** Operator-facing description, shown on the cluster detail page. */
  description: text("description"),

  /** Write-routing policy - see the enum comment above. Default to
   *  round_robin so a freshly-created cluster does something reasonable
   *  without the operator having to think. */
  writeStrategy: pdnsClusterWriteStrategyEnum("write_strategy").notNull().default("round_robin"),

  /** Who created the cluster. NULL once the creator's user row is gone. */
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),

  ...timestamps(),
});

export type PdnsCluster = typeof pdnsClusters.$inferSelect;
export type NewPdnsCluster = typeof pdnsClusters.$inferInsert;
export type PdnsClusterWriteStrategy = PdnsCluster["writeStrategy"];
