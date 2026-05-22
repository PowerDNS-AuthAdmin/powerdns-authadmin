/**
 * lib/db/repositories/settings.ts
 *
 * Read + upsert for the runtime-mutable app settings store. Values are stored
 * as `jsonb`; callers narrow with `lib/validators/settings.ts` before use.
 *
 * No team-scope yet — see `lib/db/schema/settings.ts` for the Phase-2 ALTER
 * path.
 */

import "server-only";
import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import { settings, type Setting } from "@/lib/db/schema";

export async function listAllSettings(): Promise<Setting[]> {
  return db.select().from(settings);
}

export async function upsertSetting(
  input: {
    key: string;
    value: unknown;
    updatedBy: string | null;
  },
  executor: DbExecutor = db,
): Promise<Setting> {
  const [row] = await executor
    .insert(settings)
    .values({
      key: input.key,
      value: input.value,
      updatedBy: input.updatedBy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: settings.key,
      set: {
        value: input.value,
        updatedBy: input.updatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) {
    throw new Error(`settings.upsert: ${input.key} did not return a row`);
  }
  return row;
}

export async function deleteSetting(key: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(settings).where(eq(settings.key, key));
}
