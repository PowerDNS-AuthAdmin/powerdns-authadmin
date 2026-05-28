/**
 * lib/db/schema/auth-provider-slugs.ts
 *
 * Cross-type uniqueness for provider slugs. Each provider table (OIDC today;
 * LDAP + SAML when PR 2 + PR 3 of `feat/auth-providers-ldap-saml-webauthn`
 * land) has its own `slug` column with a per-table unique index — but
 * nothing kept a SAML provider from claiming `company-sso` while an OIDC
 * provider already had it. That'd be ambiguous in the new
 * `auth_default_provider` setting (the bare-slug provisioning shorthand
 * couldn't tell them apart).
 *
 * This table is the cross-type guard: every provider create takes a
 * `(slug, type)` row in the same transaction; a duplicate slug — regardless
 * of type — fails the PK constraint. Deletes release the slug for reuse.
 *
 * Why a separate table rather than one `auth_providers` table with a
 * discriminator: ADR-0018. Provider configs are heterogeneous; this gives
 * us cross-type uniqueness without abandoning the typed per-protocol
 * schemas.
 */

import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const authProviderSlugs = pgTable("auth_provider_slugs", {
  /** The slug. Globally unique across every provider type. */
  slug: text("slug").primaryKey(),
  /** Which provider table owns this row. */
  providerType: text("provider_type").notNull(), // 'oidc' | 'saml' | 'ldap'
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuthProviderSlug = typeof authProviderSlugs.$inferSelect;
export type NewAuthProviderSlug = typeof authProviderSlugs.$inferInsert;
