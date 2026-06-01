/**
 * lib/db/repositories/oidc-providers.ts
 *
 * CRUD for the OIDC providers table. The `client_secret_encrypted` column is
 * the AES-256-GCM envelope; callers pass the already-encrypted string in /
 * receive it out - `lib/crypto/encryption.ts` does the actual encrypt /
 * decrypt at the route boundary.
 */

import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { oidcProviders, type NewOidcProvider, type OidcProvider } from "@/lib/db/schema";

export async function listAllOidcProviders(): Promise<OidcProvider[]> {
  return db.select().from(oidcProviders).orderBy(asc(oidcProviders.name));
}

export async function listEnabledOidcProviders(): Promise<OidcProvider[]> {
  return db
    .select()
    .from(oidcProviders)
    .where(eq(oidcProviders.enabled, true))
    .orderBy(asc(oidcProviders.name));
}

export async function findOidcProviderById(id: string): Promise<OidcProvider | null> {
  const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.id, id));
  return rows[0] ?? null;
}

export async function findOidcProviderBySlug(slug: string): Promise<OidcProvider | null> {
  const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.slug, slug));
  return rows[0] ?? null;
}

export async function insertOidcProvider(
  input: Omit<NewOidcProvider, "id" | "createdAt" | "updatedAt">,
  executor: DbExecutor = db,
): Promise<OidcProvider> {
  const [row] = await executor.insert(oidcProviders).values(input).returning();
  if (!row) throw new Error("oidc-providers.insert: no row returned");
  return row;
}

export async function updateOidcProvider(
  id: string,
  patch: Partial<Omit<OidcProvider, "id" | "slug" | "createdAt" | "createdBy">>,
  executor: DbExecutor = db,
): Promise<OidcProvider | null> {
  const [row] = await executor
    .update(oidcProviders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(oidcProviders.id, id))
    .returning();
  return row ?? null;
}

export async function deleteOidcProvider(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(oidcProviders).where(eq(oidcProviders.id, id));
}

/**
 * Persist the latest discovery-probe result on the provider row.
 * Narrow setter - the operator-facing Test action can't accidentally
 * touch other fields. Cache shape mirrors the schema's `$type<...>`.
 */
export async function setOidcDiscoveryCache(
  id: string,
  cache: {
    fetchedAt: string;
    ok: boolean;
    reason?: string;
    endSessionEndpoint?: string | null;
  },
): Promise<void> {
  await db
    .update(oidcProviders)
    .set({ discoveryCache: cache, updatedAt: new Date() })
    .where(eq(oidcProviders.id, id));
}
