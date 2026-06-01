/**
 * lib/db/schema/audit-log.ts
 *
 * Append-only audit log. Every state-changing action writes a row here.
 * Pruning happens via the `audit-prune` job per configured retention; rows
 * are never updated.
 *
 * `before` and `after` are JSONB snapshots - generous on size. Secrets are
 * redacted (replaced with the literal string "[Redacted]") before insertion
 * by `lib/audit/log.ts`.
 *
 * `actor_type` distinguishes user actions from automation: "user" (a session),
 * "token" (an API token), "system" (a background job or the boot path).
 *
 * The `id` is a `bigserial` rather than UUID because time-ordering by id is
 * useful and the chronological insert pattern plays well with bigserial.
 */

import {
  bigserial,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const actorTypeEnum = pgEnum("actor_type", ["user", "token", "system"]);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),

    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),

    actorType: actorTypeEnum("actor_type").notNull(),
    /** users.id when actor_type='user', api_tokens.id when 'token', NULL for 'system'. */
    actorId: uuid("actor_id"),

    /** Verb dotted: 'zone.create', 'user.update', 'session.revoke', etc. */
    action: text("action").notNull(),

    /** Subject type: 'zone', 'user', 'role', 'session', 'token', 'setting'. */
    resourceType: text("resource_type").notNull(),
    /**
     * Subject identifier. Usually a UUID as string, but can be any stable
     * identifier (zone name, slug). Stored as text to accommodate both.
     */
    resourceId: text("resource_id"),

    /** Snapshot of the resource before the change. NULL for create. */
    before: jsonb("before"),
    /** Snapshot of the resource after the change. NULL for delete. */
    after: jsonb("after"),

    /** Provenance. */
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
  },
  (t) => ({
    tsIdx: index("audit_log_ts_idx").on(t.ts),
    actorIdx: index("audit_log_actor_idx").on(t.actorType, t.actorId),
    resourceIdx: index("audit_log_resource_idx").on(t.resourceType, t.resourceId),
    actionIdx: index("audit_log_action_idx").on(t.action),
  }),
);

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
