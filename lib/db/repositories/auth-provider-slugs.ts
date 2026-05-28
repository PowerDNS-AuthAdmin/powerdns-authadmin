/**
 * lib/db/repositories/auth-provider-slugs.ts
 *
 * Read/write helpers for the cross-type slug reservation table. Every
 * provider create transaction reserves its slug here first; the table's
 * PK enforces uniqueness across OIDC / SAML / LDAP, so two providers of
 * different types can't claim the same slug.
 *
 * Deletes release the slug for reuse. Updates are not supported — slugs are
 * immutable post-create (it's the operator-facing API key for OIDC group
 * mappings, the audit log, and the `auth_default_provider` setting).
 */

import "server-only";
import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import {
  authProviderSlugs,
  type AuthProviderSlug,
  type NewAuthProviderSlug,
} from "@/lib/db/schema";

export type ProviderType = "oidc" | "saml" | "ldap";

/**
 * Reserve a slug for a given provider type. Throws on conflict (uniqueness
 * violation surfaces as a Postgres `23505` / SQLite `SQLITE_CONSTRAINT`) —
 * the caller catches and surfaces as a 409 to the operator.
 */
export async function reserveProviderSlug(
  input: NewAuthProviderSlug,
  executor: DbExecutor = db,
): Promise<AuthProviderSlug> {
  const rows = await executor.insert(authProviderSlugs).values(input).returning();
  if (!rows[0]) throw new Error("reserveProviderSlug returned no row.");
  return rows[0];
}

/** Release a slug. Idempotent — releasing an unknown slug is a no-op. */
export async function releaseProviderSlug(slug: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(authProviderSlugs).where(eq(authProviderSlugs.slug, slug));
}

/** Resolve a slug to its provider type. Returns null when the slug isn't reserved. */
export async function lookupProviderTypeBySlug(
  slug: string,
  executor: DbExecutor = db,
): Promise<ProviderType | null> {
  const rows = await executor
    .select({ providerType: authProviderSlugs.providerType })
    .from(authProviderSlugs)
    .where(eq(authProviderSlugs.slug, slug))
    .limit(1);
  const t = rows[0]?.providerType;
  return t === "oidc" || t === "saml" || t === "ldap" ? t : null;
}

/** List every reserved slug. Used by the admin authentication index. */
export async function listAllProviderSlugs(): Promise<AuthProviderSlug[]> {
  return db.select().from(authProviderSlugs);
}
