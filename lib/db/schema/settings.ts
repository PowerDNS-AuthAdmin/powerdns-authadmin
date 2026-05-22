/**
 * lib/db/schema/settings.ts
 *
 * Key-value store for runtime-mutable app settings (site name, branding URLs,
 * support contact, login intro text — anything the operator can change at
 * runtime without redeploying).
 *
 * MVP is global-scope only: one value per key, no per-team override. The
 *  §6 design adds a (scope_type, scope_id) compound primary key
 * for team-scoped settings; that ALTER lands when the team-settings UI does.
 * Until then `key` alone is the natural identifier — simpler, no NULL-in-PK
 * gymnastics, and unambiguous.
 *
 * `value` is jsonb so any shape fits: strings, booleans, structured config.
 * The application layer validates per-key against `lib/validators/settings.ts`.
 */

import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

export const settings = pgTable("settings", {
  /** Stable identifier — see KNOWN_KEYS in lib/validators/settings.ts. */
  key: text("key").primaryKey(),

  value: jsonb("value").notNull(),

  /** Who last touched this row. NULL on first-run seed. */
  updatedBy: uuid("updated_by").references(() => users.id, {
    onDelete: "set null",
  }),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Setting = typeof settings.$inferSelect;
export type NewSetting = typeof settings.$inferInsert;
