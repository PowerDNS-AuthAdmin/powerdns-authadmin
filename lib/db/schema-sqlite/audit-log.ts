/**
 * lib/db/schema-sqlite/audit-log.ts - SQLite mirror of `../schema/audit-log.ts`.
 *
 * The Postgres schema uses `bigserial` (typed as `bigint` in TS). SQLite's
 * INTEGER PRIMARY KEY AUTOINCREMENT is functionally equivalent up to 2^63,
 * but Drizzle's sqlite-core has no `bigint` mode - the value comes back as
 * `number`. Repository code that consumes audit ids treats them as opaque
 * (stringified for React keys, cast to text in queries), so the runtime
 * divergence is invisible to consumers.
 */

import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id", { mode: "number" }).primaryKey({ autoIncrement: true }),

    ts: integer("ts", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),

    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),

    action: text("action").notNull(),

    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),

    before: text("before", { mode: "json" }),
    after: text("after", { mode: "json" }),

    ip: text("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
  },
  (t) => ({
    tsIdx: index("audit_log_ts_idx").on(t.ts),
    actorIdx: index("audit_log_actor_idx").on(t.actorType, t.actorId),
    resourceIdx: index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
    actionIdx: index("audit_log_action_idx").on(t.action),
    actorTypeCheck: check(
      "audit_log_actor_type_check",
      sql`${t.actorType} IN ('user','token','system')`,
    ),
  }),
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
