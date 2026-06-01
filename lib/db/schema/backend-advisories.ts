/**
 * lib/db/schema/backend-advisories.ts
 *
 * Health advisories surfaced in the notification bell (ADR-0015). Each row is
 * one active issue for one backend, keyed by `(backend_id, code)`. The poller
 * recomputes advisories from observed state every cycle and upserts/prunes this
 * table, so it self-heals - a cleared condition's row is deleted. The only
 * operator-owned state is `acknowledged_at`. `first_seen_at` drives debounce
 * (don't ring the bell until an issue has persisted); `last_seen_at` shows age.
 */

import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { pdnsServers } from "./pdns-servers";
import { pk } from "./_helpers";

export const backendAdvisories = pgTable(
  "backend_advisories",
  {
    id: pk(),
    backendId: uuid("backend_id")
      .notNull()
      .references(() => pdnsServers.id, { onDelete: "cascade" }),
    /** Stable rule id, e.g. "secondary.cant-axfr". One row per (backend, code). */
    code: text("code").notNull(),
    /** "error" | "warn" | "info". */
    severity: text("severity").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Operator-acknowledged at; null = unacknowledged. */
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  },
  (t) => ({
    backendCodeIdx: uniqueIndex("backend_advisories_backend_code_idx").on(t.backendId, t.code),
    backendIdx: index("backend_advisories_backend_idx").on(t.backendId),
  }),
);

export type BackendAdvisory = typeof backendAdvisories.$inferSelect;
export type NewBackendAdvisory = typeof backendAdvisories.$inferInsert;
