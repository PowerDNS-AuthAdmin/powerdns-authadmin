/**
 * lib/db/schema-sqlite/oidc-providers.ts - SQLite mirror of `../schema/oidc-providers.ts`.
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const oidcProviders = sqliteTable(
  "oidc_providers",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: text("client_secret_encrypted").notNull(),
    scopes: text("scopes").notNull().default("openid profile email"),
    claimEmail: text("claim_email").notNull().default("email"),
    claimName: text("claim_name").notNull().default("name"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    requireEmailVerified: integer("require_email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    discoveryCache: text("discovery_cache", { mode: "json" }).$type<{
      fetchedAt: string;
      ok: boolean;
      reason?: string;
      endSessionEndpoint?: string | null;
    } | null>(),
    iconUrl: text("icon_url"),
    allowedEmailDomains: text("allowed_email_domains", { mode: "json" }).$type<string[]>(),
    groupMappings: text("group_mappings", { mode: "json" }).$type<OidcGroupMapping[]>(),
    claimGroups: text("claim_groups").notNull().default("groups"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("oidc_providers_slug_idx").on(t.slug),
  }),
);

export type OidcProvider = typeof oidcProviders.$inferSelect;
export type NewOidcProvider = typeof oidcProviders.$inferInsert;

/** Same shape as the PG side; re-declared here to keep the SQLite schema
 *  module standalone (avoid a cross-dialect import that would re-introduce
 *  circular complexity). */
export interface OidcGroupMapping {
  group: string;
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}
