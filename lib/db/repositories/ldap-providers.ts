/**
 * lib/db/repositories/ldap-providers.ts
 *
 * CRUD for the LDAP providers table (ADR-0020). Same pattern as the OIDC
 * repository — the `bind_password_encrypted` column is the AES-256-GCM
 * envelope; callers encrypt at the route boundary via `lib/crypto/encryption.ts`.
 */

import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { ldapProviders, type LdapProvider, type NewLdapProvider } from "@/lib/db/schema";

export async function listAllLdapProviders(): Promise<LdapProvider[]> {
  return db.select().from(ldapProviders).orderBy(asc(ldapProviders.name));
}

export async function listEnabledLdapProviders(): Promise<LdapProvider[]> {
  return db
    .select()
    .from(ldapProviders)
    .where(eq(ldapProviders.enabled, true))
    .orderBy(asc(ldapProviders.name));
}

export async function findLdapProviderById(id: string): Promise<LdapProvider | null> {
  const rows = await db.select().from(ldapProviders).where(eq(ldapProviders.id, id));
  return rows[0] ?? null;
}

export async function findLdapProviderBySlug(slug: string): Promise<LdapProvider | null> {
  const rows = await db.select().from(ldapProviders).where(eq(ldapProviders.slug, slug));
  return rows[0] ?? null;
}

export async function insertLdapProvider(
  input: Omit<NewLdapProvider, "id" | "createdAt" | "updatedAt">,
  executor: DbExecutor = db,
): Promise<LdapProvider> {
  const [row] = await executor.insert(ldapProviders).values(input).returning();
  if (!row) throw new Error("ldap-providers.insert: no row returned");
  return row;
}

export async function updateLdapProvider(
  id: string,
  patch: Partial<Omit<LdapProvider, "id" | "slug" | "createdAt" | "createdBy">>,
  executor: DbExecutor = db,
): Promise<LdapProvider | null> {
  const [row] = await executor
    .update(ldapProviders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(ldapProviders.id, id))
    .returning();
  return row ?? null;
}

export async function deleteLdapProvider(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(ldapProviders).where(eq(ldapProviders.id, id));
}
