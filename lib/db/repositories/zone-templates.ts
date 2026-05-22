/**
 * lib/db/repositories/zone-templates.ts
 *
 * CRUD for zone templates. Records and nameservers are stored as JSONB and
 * validated against the per-RR-type validators at the route boundary;
 * nothing here interprets them.
 */

import "server-only";
import { asc, eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { zoneTemplates, type NewZoneTemplate, type ZoneTemplate } from "@/lib/db/schema";

export async function listAllZoneTemplates(): Promise<ZoneTemplate[]> {
  return db.select().from(zoneTemplates).orderBy(asc(zoneTemplates.name));
}

export async function findZoneTemplateById(id: string): Promise<ZoneTemplate | null> {
  const rows = await db.select().from(zoneTemplates).where(eq(zoneTemplates.id, id));
  return rows[0] ?? null;
}

export async function findZoneTemplateBySlug(slug: string): Promise<ZoneTemplate | null> {
  const rows = await db.select().from(zoneTemplates).where(eq(zoneTemplates.slug, slug));
  return rows[0] ?? null;
}

export async function insertZoneTemplate(
  input: Omit<NewZoneTemplate, "id" | "createdAt" | "updatedAt">,
  executor: DbExecutor = db,
): Promise<ZoneTemplate> {
  const [row] = await executor.insert(zoneTemplates).values(input).returning();
  if (!row) throw new Error("zone-templates.insert: no row returned");
  return row;
}

export async function updateZoneTemplate(
  id: string,
  patch: Partial<Omit<ZoneTemplate, "id" | "slug" | "createdAt" | "createdBy">>,
  executor: DbExecutor = db,
): Promise<ZoneTemplate | null> {
  const [row] = await executor
    .update(zoneTemplates)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(zoneTemplates.id, id))
    .returning();
  return row ?? null;
}

export async function deleteZoneTemplate(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(zoneTemplates).where(eq(zoneTemplates.id, id));
}
