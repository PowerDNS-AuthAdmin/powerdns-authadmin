/**
 * lib/db/repositories/pdns-servers.ts
 *
 * Data-access for `pdns_servers`. Pure queries — no business rules, no
 * authorization, no encryption. Callers (admin route handlers, the PdnsClient
 * registry) own those decisions.
 *
 * The `apiKeyEncrypted` column stays opaque at this layer; callers passing a
 * plaintext API key must encrypt it via `lib/crypto/encryption.ts` first.
 * The repository never logs the value (Pino's redactor also covers
 * `*.apiKey` / `*.api_key` field shapes — defense in depth).
 */

import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import {
  pdnsServers,
  type NewPdnsServer,
  type PdnsServer,
  type PdnsVersionCache,
} from "@/lib/db/schema";

/**
 * List every active (non-disabled) PRIMARY backend. The default for all
 * read paths — the zones list, dashboards, write APIs all operate on
 * primaries. Use `listActiveSecondariesForPrimary` or
 * `listAllActiveBackends` when you genuinely need secondaries too.
 */
export async function listActivePdnsServers(): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(and(isNull(pdnsServers.disabledAt), eq(pdnsServers.role, "primary")))
    .orderBy(pdnsServers.name);
}

/** Every active backend regardless of role — for the stats sampler. */
export async function listAllActiveBackends(): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(isNull(pdnsServers.disabledAt))
    .orderBy(pdnsServers.name);
}

/** Secondaries attached to a given primary. */
export async function listActiveSecondariesForPrimary(primaryId: string): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(
      and(
        isNull(pdnsServers.disabledAt),
        eq(pdnsServers.role, "secondary"),
        eq(pdnsServers.primaryId, primaryId),
      ),
    )
    .orderBy(pdnsServers.name);
}

/** List every backend, including disabled ones (admin view). */
export async function listAllPdnsServers(): Promise<PdnsServer[]> {
  return db.select().from(pdnsServers).orderBy(pdnsServers.name);
}

/** Just the primaries (any disabled state) — for the admin servers list. */
export async function listAllPrimaries(): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(eq(pdnsServers.role, "primary"))
    .orderBy(pdnsServers.name);
}

/** Find a backend by id. */
export async function findPdnsServerById(id: string): Promise<PdnsServer | null> {
  const rows = await db.select().from(pdnsServers).where(eq(pdnsServers.id, id)).limit(1);
  return rows[0] ?? null;
}

/** Find a backend by slug. */
export async function findPdnsServerBySlug(slug: string): Promise<PdnsServer | null> {
  const rows = await db.select().from(pdnsServers).where(eq(pdnsServers.slug, slug)).limit(1);
  return rows[0] ?? null;
}

/**
 * The default backend used when an API request omits `?server=`. Returns the
 * row marked `is_default=true` and not disabled, or — if there's exactly one
 * active server — that one. Otherwise null.
 */
export async function findDefaultPdnsServer(): Promise<PdnsServer | null> {
  // Defaults are always primaries — secondaries are observation targets
  // for stats + sync diff, never the implicit write target.
  const marked = await db
    .select()
    .from(pdnsServers)
    .where(
      and(
        eq(pdnsServers.isDefault, true),
        isNull(pdnsServers.disabledAt),
        eq(pdnsServers.role, "primary"),
      ),
    )
    .limit(1);
  if (marked[0]) return marked[0];

  const active = await listActivePdnsServers();
  return active.length === 1 ? (active[0] ?? null) : null;
}

/**
 * Insert a backend. The caller is responsible for encrypting the API key. If
 * `isDefault` is true, any other default-flagged row is cleared in the same
 * transaction — exactly one default at a time.
 */
export async function insertPdnsServer(input: NewPdnsServer): Promise<PdnsServer> {
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx
        .update(pdnsServers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(pdnsServers.isDefault, true));
    }
    const rows = await tx.insert(pdnsServers).values(input).returning();
    if (!rows[0]) throw new Error("pdns_servers insert returned no row.");
    return rows[0];
  });
}

/**
 * Update mutable fields. Same default-uniqueness invariant applies — setting
 * `isDefault: true` clears the flag on every other row inside the same
 * transaction. The id and createdAt columns are immutable.
 */
export async function updatePdnsServer(
  id: string,
  patch: Partial<Omit<PdnsServer, "id" | "createdAt">>,
): Promise<PdnsServer | null> {
  return db.transaction(async (tx) => {
    if (patch.isDefault === true) {
      await tx
        .update(pdnsServers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(pdnsServers.isDefault, true));
    }
    const rows = await tx
      .update(pdnsServers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(pdnsServers.id, id))
      .returning();
    return rows[0] ?? null;
  });
}

/** Persist a successful version probe back to the row. */
export async function setPdnsVersionCache(id: string, cache: PdnsVersionCache): Promise<void> {
  await db
    .update(pdnsServers)
    .set({ versionCache: cache, updatedAt: new Date() })
    .where(eq(pdnsServers.id, id));
}

/** Hard-delete a backend. Audit log carries the historical trail. */
export async function deletePdnsServer(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(pdnsServers).where(eq(pdnsServers.id, id));
}
