/**
 * lib/db/schema-sqlite/ldap-providers.ts — SQLite mirror of `../schema/ldap-providers.ts`.
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const ldapProviders = sqliteTable(
  "ldap_providers",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    serverUrl: text("server_url").notNull(),
    startTls: integer("start_tls", { mode: "boolean" }).notNull().default(false),
    bindDn: text("bind_dn").notNull(),
    bindPasswordEncrypted: text("bind_password_encrypted").notNull(),
    userSearchBase: text("user_search_base").notNull(),
    userSearchFilter: text("user_search_filter")
      .notNull()
      .default("(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))"),
    groupSearchBase: text("group_search_base"),
    groupSearchFilter: text("group_search_filter"),
    groupAttr: text("group_attr").notNull().default("memberOf"),
    claimEmail: text("claim_email").notNull().default("mail"),
    claimName: text("claim_name").notNull().default("displayName"),
    tlsCaCert: text("tls_ca_cert"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    allowedEmailDomains: text("allowed_email_domains", { mode: "json" }).$type<string[]>(),
    groupMappings: text("group_mappings", { mode: "json" }).$type<LdapGroupMapping[]>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("ldap_providers_slug_idx").on(t.slug),
  }),
);

export type LdapProvider = typeof ldapProviders.$inferSelect;
export type NewLdapProvider = typeof ldapProviders.$inferInsert;

/** Same shape as the PG side; re-declared here to keep the SQLite schema
 *  module standalone — same convention as the OIDC mirror. */
export interface LdapGroupMapping {
  group: string;
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}
