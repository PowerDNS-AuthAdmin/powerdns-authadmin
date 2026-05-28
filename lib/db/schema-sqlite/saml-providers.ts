/**
 * lib/db/schema-sqlite/saml-providers.ts — SQLite mirror of `../schema/saml-providers.ts`.
 */

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { users } from "./users";
import { pk, timestamps } from "./_helpers";

export const samlProviders = sqliteTable(
  "saml_providers",
  {
    id: pk(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    idpEntityId: text("idp_entity_id").notNull(),
    idpSsoUrl: text("idp_sso_url").notNull(),
    idpSloUrl: text("idp_slo_url"),
    idpSigningCert: text("idp_signing_cert").notNull(),
    spSigningKeyEncrypted: text("sp_signing_key_encrypted").notNull(),
    spSigningCert: text("sp_signing_cert").notNull(),
    spEncryptionKeyEncrypted: text("sp_encryption_key_encrypted"),
    spEncryptionCert: text("sp_encryption_cert"),
    requireSignedResponse: integer("require_signed_response", { mode: "boolean" })
      .notNull()
      .default(true),
    requireEncryptedAssertion: integer("require_encrypted_assertion", { mode: "boolean" })
      .notNull()
      .default(false),
    signatureAlgorithm: text("signature_algorithm").notNull().default("sha256"),
    nameIdFormat: text("name_id_format")
      .notNull()
      .default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
    claimEmail: text("claim_email").notNull().default("email"),
    claimName: text("claim_name").notNull().default("name"),
    claimGroups: text("claim_groups").notNull().default("groups"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    allowedEmailDomains: text("allowed_email_domains", { mode: "json" }).$type<string[]>(),
    groupMappings: text("group_mappings", { mode: "json" }).$type<SamlGroupMapping[]>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => ({
    slugIdx: uniqueIndex("saml_providers_slug_idx").on(t.slug),
  }),
);

export type SamlProvider = typeof samlProviders.$inferSelect;
export type NewSamlProvider = typeof samlProviders.$inferInsert;

/** Same shape as the PG side; standalone declaration to keep dialect modules
 *  importable in isolation. */
export interface SamlGroupMapping {
  group: string;
  roleSlug: string;
  scopeType: "global" | "team" | "zone" | "server";
  scopeId: string | null;
}
