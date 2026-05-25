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
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import {
  pdnsServers,
  type NewPdnsServer,
  type PdnsServer,
  type PdnsVersionCache,
  type PdnsDaemonCapabilities,
} from "@/lib/db/schema";
import { isReadOnlyMirror, isWriteCapable } from "@/lib/pdns/capabilities";

/**
 * Active (non-disabled) WRITE-TARGET backends — the default for read paths
 * (zones list, dashboards, write APIs). A backend is a write target when its
 * observed capabilities report `primary`, or it hasn't been probed yet
 * (ADR-0014). Replaces the old `role='primary'` filter. Use
 * `listSecondariesForPrimary` / `listAllActiveBackends` for mirrors.
 */
export async function listActivePdnsServers(): Promise<PdnsServer[]> {
  const rows = await db
    .select()
    .from(pdnsServers)
    .where(isNull(pdnsServers.disabledAt))
    .orderBy(pdnsServers.name);
  return rows.filter((r) => isWriteCapable(r.capabilities));
}

/** Every active backend regardless of role — for the stats sampler. */
export async function listAllActiveBackends(): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(isNull(pdnsServers.disabledAt))
    .orderBy(pdnsServers.name);
}

/**
 * Active secondaries that belong to NO group (`cluster_id` null) — they mirror
 * an external / unmanaged primary, so the app can only browse their zones
 * read-only. The amalgamated zones list uses this to surface those otherwise-
 * invisible zones (deduped against primary zones).
 */
export async function listUngroupedSecondaries(): Promise<PdnsServer[]> {
  const rows = await db
    .select()
    .from(pdnsServers)
    .where(and(isNull(pdnsServers.disabledAt), isNull(pdnsServers.clusterId)))
    .orderBy(pdnsServers.name);
  return rows.filter((r) => isReadOnlyMirror(r.capabilities));
}

/** Active read-only-mirror members of a group (ADR-0014 capability classification). */
export async function listClusterSecondaries(clusterId: string): Promise<PdnsServer[]> {
  const rows = await db
    .select()
    .from(pdnsServers)
    .where(and(isNull(pdnsServers.disabledAt), eq(pdnsServers.clusterId, clusterId)))
    .orderBy(pdnsServers.name);
  return rows.filter((r) => isReadOnlyMirror(r.capabilities));
}

/**
 * Active secondaries that mirror a given primary (ADR-0014): the secondary-
 * capable members of the primary's group. A primary in no group has no
 * app-managed secondaries. Replaces the old `primary_id` pin; the precise
 * per-zone edges are derived from each mirror zone's `masters[]`.
 */
export async function listSecondariesForPrimary(primary: PdnsServer): Promise<PdnsServer[]> {
  if (!primary.clusterId) return [];
  return listClusterSecondaries(primary.clusterId);
}

/** List every backend, including disabled ones (admin view). */
export async function listAllPdnsServers(): Promise<PdnsServer[]> {
  return db.select().from(pdnsServers).orderBy(pdnsServers.name);
}

/**
 * Active backends that belong to no group yet (`cluster_id` null) — the pool a
 * "new group" form can pull initial members from. Servers already in a group
 * are excluded so creating a group never silently steals a peer from another.
 */
export async function listUngroupedServers(): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(and(isNull(pdnsServers.disabledAt), isNull(pdnsServers.clusterId)))
    .orderBy(pdnsServers.name);
}

/**
 * Point a backend at a group (or detach it when `clusterId` is null). Executor-
 * aware so a group create can assign its initial members in the same
 * transaction. Returns the updated row, or null if the id no longer exists.
 */
export async function assignServerToCluster(
  id: string,
  clusterId: string | null,
  executor: DbExecutor = db,
): Promise<PdnsServer | null> {
  const rows = await executor
    .update(pdnsServers)
    .set({ clusterId, updatedAt: new Date() })
    .where(eq(pdnsServers.id, id))
    .returning();
  return rows[0] ?? null;
}

/** Write-target backends, any disabled state — for admin lists/pickers. */
export async function listAllPrimaries(): Promise<PdnsServer[]> {
  const rows = await db.select().from(pdnsServers).orderBy(pdnsServers.name);
  return rows.filter((r) => isWriteCapable(r.capabilities));
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
  // The default is the implicit write target, so it must be write-capable
  // (ADR-0014) — a read-only mirror is never the default.
  const marked = await db
    .select()
    .from(pdnsServers)
    .where(and(eq(pdnsServers.isDefault, true), isNull(pdnsServers.disabledAt)))
    .limit(1);
  if (marked[0] && isWriteCapable(marked[0].capabilities)) return marked[0];

  const active = await listActivePdnsServers();
  return active.length === 1 ? (active[0] ?? null) : null;
}

/**
 * Resolve which backend a per-server *inspection* page (autoprimaries, TSIG, …)
 * should land on: the explicitly-requested slug, else the FIRST backend in the
 * (name-ordered) tab list. It deliberately does NOT prefer the is_default write
 * target — that could sort anywhere among the tabs and made the highlighted tab
 * appear to jump to the "last" backend; landing on the first tab is predictable.
 * Lands happily on a secondary too, since these pages read/manage server-level
 * config (autoprimaries, TSIG keys) that is valid on secondaries — so a
 * secondary-only deployment doesn't dead-end on "No backend selected".
 */
export async function findServerToInspect(requestedSlug?: string): Promise<PdnsServer | null> {
  if (requestedSlug) {
    const bySlug = await findPdnsServerBySlug(requestedSlug);
    if (bySlug) return bySlug;
  }
  // Same source + order as the pages' tab nav (listAllPdnsServers, by name,
  // enabled-only), so the default selection is always the leftmost tab.
  const active = await listAllActiveBackends();
  return active[0] ?? null;
}

/**
 * Insert a backend. The caller is responsible for encrypting the API key. If
 * `isDefault` is true, any other default-flagged row is cleared in the same
 * transaction — exactly one default at a time.
 *
 * Executor-aware: pass a `tx` so the route can group the default-clearing +
 * insert + `appendAudit` into ONE transaction. Called bare, it opens its own
 * transaction so the single-default invariant still holds.
 */
export async function insertPdnsServer(
  input: NewPdnsServer,
  executor: DbExecutor = db,
): Promise<PdnsServer> {
  const run = async (tx: DbExecutor): Promise<PdnsServer> => {
    if (input.isDefault) {
      await tx
        .update(pdnsServers)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(pdnsServers.isDefault, true));
    }
    const rows = await tx.insert(pdnsServers).values(input).returning();
    if (!rows[0]) throw new Error("pdns_servers insert returned no row.");
    return rows[0];
  };
  // When the caller supplies an executor it owns the transaction; the two
  // statements above already run inside it. Bare calls need their own tx to
  // keep the clear-then-insert atomic.
  return executor === db ? db.transaction(run) : run(executor);
}

/**
 * Update mutable fields. Same default-uniqueness invariant applies — setting
 * `isDefault: true` clears the flag on every other row inside the same
 * transaction. The id and createdAt columns are immutable.
 *
 * Executor-aware: pass a `tx` so the route can group the default-clearing +
 * update + `appendAudit` into ONE transaction. Called bare, it opens its own
 * transaction so the single-default invariant still holds.
 */
export async function updatePdnsServer(
  id: string,
  patch: Partial<Omit<PdnsServer, "id" | "createdAt">>,
  executor: DbExecutor = db,
): Promise<PdnsServer | null> {
  const run = async (tx: DbExecutor): Promise<PdnsServer | null> => {
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
  };
  return executor === db ? db.transaction(run) : run(executor);
}

/**
 * Persist a successful version probe back to the row. A successful probe
 * is also proof of reachability, so it bumps `last_seen_at` alongside the
 * cache — keeps the manual Test / Refresh-all path in step with the
 * poller's continuous `markPdnsServersSeen` updates.
 */
export async function setPdnsVersionCache(id: string, cache: PdnsVersionCache): Promise<void> {
  const now = new Date();
  await db
    .update(pdnsServers)
    .set({ versionCache: cache, lastSeenAt: now, updatedAt: now })
    .where(eq(pdnsServers.id, id));
}

/**
 * Persist a freshly-observed daemon capability snapshot (ADR-0014). Also bumps
 * `last_seen_at` — reading `/config` means we reached the backend. Deliberately
 * leaves `updated_at` untouched: capabilities don't affect the cached
 * PdnsClient (base URL / API key), so there's no reason to bust the registry
 * cache, same reasoning as markPdnsServersSeen.
 */
export async function setPdnsCapabilities(
  id: string,
  capabilities: PdnsDaemonCapabilities,
): Promise<void> {
  await db
    .update(pdnsServers)
    .set({ capabilities, lastSeenAt: new Date() })
    .where(eq(pdnsServers.id, id));
}

/**
 * Bump `last_seen_at` for every backend we just successfully reached.
 * Called by the background poller each cycle for the backends whose
 * zone-list fetch succeeded.
 *
 * Deliberately does NOT touch `updated_at`: that column gates the
 * PdnsClient registry cache (`lib/pdns/registry.ts`), so bumping it every
 * poll cycle would force an API-key decrypt + client rebuild every 30s.
 * One batched UPDATE covers the whole fleet.
 */
export async function markPdnsServersSeen(ids: string[], at: Date = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await db.update(pdnsServers).set({ lastSeenAt: at }).where(inArray(pdnsServers.id, ids));
}

/** Hard-delete a backend. Audit log carries the historical trail. */
export async function deletePdnsServer(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(pdnsServers).where(eq(pdnsServers.id, id));
}
