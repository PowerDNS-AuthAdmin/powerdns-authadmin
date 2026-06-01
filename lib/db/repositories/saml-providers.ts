/**
 * lib/db/repositories/saml-providers.ts
 *
 * CRUD for the SAML providers table. Mirrors `oidc-providers.ts` shape so
 * route + UI code can stay structurally parallel. The encrypted PEM columns
 * are passed through unchanged - encryption / decryption happens at the
 * route boundary via `lib/crypto/encryption.ts`.
 */

import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { samlProviders, type NewSamlProvider, type SamlProvider } from "@/lib/db/schema";

export async function listAllSamlProviders(): Promise<SamlProvider[]> {
  return db.select().from(samlProviders).orderBy(asc(samlProviders.name));
}

export async function listEnabledSamlProviders(): Promise<SamlProvider[]> {
  return db
    .select()
    .from(samlProviders)
    .where(eq(samlProviders.enabled, true))
    .orderBy(asc(samlProviders.name));
}

export async function findSamlProviderById(id: string): Promise<SamlProvider | null> {
  const rows = await db.select().from(samlProviders).where(eq(samlProviders.id, id));
  return rows[0] ?? null;
}

export async function findSamlProviderBySlug(slug: string): Promise<SamlProvider | null> {
  const rows = await db.select().from(samlProviders).where(eq(samlProviders.slug, slug));
  return rows[0] ?? null;
}

export async function insertSamlProvider(
  input: Omit<NewSamlProvider, "id" | "createdAt" | "updatedAt">,
  executor: DbExecutor = db,
): Promise<SamlProvider> {
  const [row] = await executor.insert(samlProviders).values(input).returning();
  if (!row) throw new Error("saml-providers.insert: no row returned");
  return row;
}

export async function updateSamlProvider(
  id: string,
  patch: Partial<Omit<SamlProvider, "id" | "slug" | "createdAt" | "createdBy">>,
  executor: DbExecutor = db,
): Promise<SamlProvider | null> {
  const [row] = await executor
    .update(samlProviders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(samlProviders.id, id))
    .returning();
  return row ?? null;
}

export async function deleteSamlProvider(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(samlProviders).where(eq(samlProviders.id, id));
}
