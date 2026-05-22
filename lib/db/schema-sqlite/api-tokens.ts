/**
 * lib/db/schema-sqlite/api-tokens.ts — SQLite mirror of `../schema/api-tokens.ts`.
 */

import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { teams } from "./teams";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

type StoredPermission = string;

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<StoredPermission[]>().notNull().default([]),
    teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    lastUsedIp: text("last_used_ip"),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    ...timestamps(),
  },
  (t) => ({
    userIdx: index("api_tokens_user_idx").on(t.userId),
    prefixIdx: uniqueIndex("api_tokens_prefix_idx").on(t.prefix),
    teamIdx: index("api_tokens_team_idx").on(t.teamId),
  }),
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
