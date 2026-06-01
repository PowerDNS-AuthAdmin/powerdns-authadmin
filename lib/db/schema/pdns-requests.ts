/**
 * lib/db/schema/pdns-requests.ts
 *
 * Raw log of every HTTP request issued against a PowerDNS backend. Joined
 * to audit events through `request_id` so the change-history feed can show
 * "the actual HTTP traffic for this operation" inline.
 *
 * Sensitive material (the X-API-Key header, TSIG secrets in response
 * bodies) is redacted at write time - the row stores something readable
 * for an operator without leaking credentials to anyone with audit.read.
 *
 * Retention: not yet enforced. A periodic job should prune rows older
 * than ~30 days once volume becomes meaningful (every page-load triggers
 * `listZones`; this fills up fast on busy installs).
 */

import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pdnsServers } from "./pdns-servers";

export const pdnsRequests = pgTable(
  "pdns_requests",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Operation correlation id - every audit row + PDNS request from the
     * same HTTP request shares this. Indexed for the per-row lookup the
     * change-history feed performs.
     */
    requestId: text("request_id"),
    /** FK to the backend the request went to. `set null` so removing a
     *  PDNS server doesn't cascade-delete its request log. */
    serverId: uuid("server_id").references(() => pdnsServers.id, { onDelete: "set null" }),
    /** Server slug snapshot - survives even after `serverId` is nulled. */
    serverSlug: text("server_slug"),
    /** Logical op name passed by the client method (`zones.list`,
     *  `zone.metadata.set`, …). Matches the Pino log tag. */
    op: text("op").notNull(),
    method: text("method").notNull(),
    /** Full URL with path + query. */
    url: text("url").notNull(),
    /** Outbound headers minus X-API-Key (replaced with `<redacted>`). */
    requestHeaders: jsonb("request_headers").$type<Record<string, string>>(),
    /**
     * Outbound JSON body (or null for GET/DELETE). Strings stored as
     * strings, objects stored verbatim - the viewer pretty-prints.
     */
    requestBody: jsonb("request_body"),
    /**
     * HTTP status code returned by PDNS. Null when the request never
     * completed (transport error, timeout, abort). Useful for at-a-glance
     * "did this succeed?" without ballooning the table with full bodies.
     */
    responseStatus: integer("response_status"),
    /** Transport / abort / parse error message, when the call didn't complete. */
    error: text("error"),
  },
  (t) => ({
    requestIdIdx: index("pdns_requests_request_id_idx").on(t.requestId),
    tsIdx: index("pdns_requests_ts_idx").on(t.ts),
    serverIdIdx: index("pdns_requests_server_id_idx").on(t.serverId),
  }),
);

export type PdnsRequestRow = typeof pdnsRequests.$inferSelect;
export type NewPdnsRequestRow = typeof pdnsRequests.$inferInsert;
