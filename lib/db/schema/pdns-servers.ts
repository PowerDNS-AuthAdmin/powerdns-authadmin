/**
 * lib/db/schema/pdns-servers.ts
 *
 * One row per upstream PowerDNS Authoritative server we administer. First-
 * class multi-backend support is the headlinefeature (legacy issues
 * #489, #791, #687).
 *
 * The PDNS API key is "tier-0" sensitive — wrapped in our `encrypt()`
 * envelope at rest, redacted in logs, and never round-tripped to the client.
 * `version_cache` is a JSON snapshot of the last successful `GET /servers/{id}`
 * + parsed feature flags, used so the UI can show server health without
 * touching the network on every page render.
 */

import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { PdnsDaemonCapabilities, PdnsVersionCache } from "@/lib/pdns/types";
import { pdnsClusters } from "./pdns-clusters";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

// PdnsVersionCache lives in lib/pdns/types.ts so the PDNS protocol
// adapter doesn't have to cross the import-boundary rule that forbids
// `lib/pdns → lib/db`. Re-exported here so existing callers that import
// the type from this file (the historical location) keep working.
export type { PdnsVersionCache, PdnsDaemonCapabilities } from "@/lib/pdns/types";

export const pdnsServers = pgTable(
  "pdns_servers",
  {
    id: pk(),

    /** URL-safe slug (`/admin/servers/<slug>`). */
    slug: text("slug").notNull(),

    /** Display name. */
    name: text("name").notNull(),

    /**
     * Operator-facing free-text note. "Dev box in eu-west", "prod
     * cluster, do not edit", etc. Surfaced on the servers list +
     * detail page; never sent to PDNS. Nullable — operators with a
     * single backend rarely need it.
     */
    description: text("description"),

    /**
     * Base URL of the PowerDNS HTTP API root, *without* the trailing
     * `/servers/...` segment. The client appends the rest. Stored without a
     * trailing slash; the validator enforces that.
     *
     * @example "http://pdns.internal:8081/api/v1"
     */
    baseUrl: text("base_url").notNull(),

    /**
     * Server id within the PDNS API surface — the path segment after
     * `/servers/`. Almost always `localhost`; configurable so a single PDNS
     * exposing multiple instances is reachable.
     */
    serverId: text("server_id").notNull().default("localhost"),

    /** AES-256-GCM envelope of the X-API-Key. See lib/crypto/encryption.ts. */
    apiKeyEncrypted: text("api_key_encrypted").notNull(),

    /** Last successful version probe; null until probed. */
    versionCache: jsonb("version_cache").$type<PdnsVersionCache | null>(),

    /**
     * OBSERVED daemon capabilities from the read-only `/config` (ADR-0014):
     * primary/secondary/autosecondary, launch backends, DNSSEC. Refreshed on
     * each version probe. This is the per-daemon truth that supersedes the
     * operator-declared `role`. Null until first observed; carries its own
     * `fetchedAt` like `version_cache`.
     */
    capabilities: jsonb("capabilities").$type<PdnsDaemonCapabilities | null>(),

    /**
     * Operator-declared DNS addresses this backend serves on — the values
     * other backends list in a slave zone's `masters[]` (ADR-0014). Used to
     * derive replication edges by matching `masters[]` against this set. NULL
     * means "derive from the API base URL host"; an explicit array overrides
     * (for setups where the API host ≠ the DNS address).
     */
    advertisedAddresses: jsonb("advertised_addresses").$type<string[] | null>(),

    /**
     * Last time we successfully *reached* this backend — set by the
     * background poller on every successful zone-list fetch, and by a
     * successful version probe (Test / Refresh all). Distinct from
     * `version_cache.fetchedAt`, which only moves when the *version* is
     * re-probed: the poller hits `listZones`/`statistics` every 30–60s
     * but never re-probes the version, so `fetchedAt` goes stale under
     * healthy continuous polling. This column tracks live reachability,
     * so the Status badge and the dashboard "stale backend" attention
     * reflect actual polling rather than the last manual probe. Null
     * until the first successful contact.
     */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    /**
     * Default backend used when a request doesn't specify `?server=`. Exactly
     * zero or one row should be marked default at any time — the application
     * layer enforces this transactionally (we'd need a partial unique index
     * to do it in pure SQL and the simpler app-layer guard is fine for now).
     */
    isDefault: boolean("is_default").notNull().default(false),

    /**
     * Group membership (ADR-0014). A group is any set of related backends —
     * the writable peers of a multi-primary cluster, OR a primary together
     * with its secondaries. NULL means the backend stands alone. A primary's
     * secondaries are the secondary-capable members of its group; the precise
     * primary→secondary edges are derived from each mirror zone's `masters[]`.
     * ON DELETE SET NULL keeps the row if the group goes away.
     *
     * (Historically named `cluster_id`; kept for migration stability. The
     * table is `pdns_clusters`.)
     */
    clusterId: uuid("cluster_id").references(() => pdnsClusters.id, {
      onDelete: "set null",
    }),

    /** Soft-disable. Disabled servers stay in the DB for audit history. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),

    /** Who added it. NULL for system-seeded backends. */
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),

    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("pdns_servers_slug_idx").on(t.slug),
    defaultIdx: index("pdns_servers_default_idx").on(t.isDefault),
    disabledIdx: index("pdns_servers_disabled_idx").on(t.disabledAt),
    clusterIdx: index("pdns_servers_cluster_id_idx").on(t.clusterId),
  }),
);

export type PdnsServer = typeof pdnsServers.$inferSelect;
export type NewPdnsServer = typeof pdnsServers.$inferInsert;
