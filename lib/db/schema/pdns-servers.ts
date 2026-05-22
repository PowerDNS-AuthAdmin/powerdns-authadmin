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
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { PdnsVersionCache } from "@/lib/pdns/types";
import { pdnsClusters } from "./pdns-clusters";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

// PdnsVersionCache lives in lib/pdns/types.ts so the PDNS protocol
// adapter doesn't have to cross the import-boundary rule that forbids
// `lib/pdns → lib/db`. Re-exported here so existing callers that import
// the type from this file (the historical location) keep working.
export type { PdnsVersionCache } from "@/lib/pdns/types";

/**
 * Whether a backend is the authoritative source we write to (`primary`)
 * or a read-only mirror we poll for sync state + stats (`secondary`).
 * Secondaries reference a primary via `primary_id`. The application
 * routes all writes (record edits, zone create/delete, notify,
 * settings, metadata) to primaries only; secondaries are observed.
 */
export const pdnsServerRoleEnum = pgEnum("pdns_server_role", ["primary", "secondary"]);

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
     * Default backend used when a request doesn't specify `?server=`. Exactly
     * zero or one row should be marked default at any time — the application
     * layer enforces this transactionally (we'd need a partial unique index
     * to do it in pure SQL and the simpler app-layer guard is fine for now).
     */
    isDefault: boolean("is_default").notNull().default(false),

    /**
     * Backend role — see `pdnsServerRoleEnum`. Defaults to `primary` so
     * existing rows pre-migration are interpreted as writable. New rows
     * inserted via the admin UI must choose explicitly.
     */
    role: pdnsServerRoleEnum("role").notNull().default("primary"),

    /**
     * For `role='secondary'`: the primary this secondary mirrors.
     * NULL for primaries. Deleting the primary cascades to its
     * secondaries — they have no meaning without their primary.
     */
    primaryId: uuid("primary_id").references((): AnyPgColumn => pdnsServers.id, {
      onDelete: "cascade",
    }),

    /**
     * Multi-primary cluster membership (peer mode). When set, this row is
     * one of N writable peers whose underlying storage replicates
     * via the backend (Galera, Postgres logical replication, etc.). All
     * peers in a cluster have `role='primary'`; the cluster groups them.
     * NULL means this server is either a standalone primary or a
     * traditional secondary mirror. ON DELETE SET NULL keeps the row
     * around if the cluster goes away — the server just falls back to
     * standalone-primary semantics.
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
    roleIdx: index("pdns_servers_role_idx").on(t.role),
    primaryIdx: index("pdns_servers_primary_id_idx").on(t.primaryId),
    clusterIdx: index("pdns_servers_cluster_id_idx").on(t.clusterId),
  }),
);

export type PdnsServer = typeof pdnsServers.$inferSelect;
export type NewPdnsServer = typeof pdnsServers.$inferInsert;
