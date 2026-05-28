/**
 * lib/db/schema-sqlite/auth-provider-slugs.ts — SQLite mirror of
 * `../schema/auth-provider-slugs.ts`.
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const authProviderSlugs = sqliteTable("auth_provider_slugs", {
  slug: text("slug").primaryKey(),
  providerType: text("provider_type").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type AuthProviderSlug = typeof authProviderSlugs.$inferSelect;
export type NewAuthProviderSlug = typeof authProviderSlugs.$inferInsert;
