/**
 * lib/pdns/registry.ts
 *
 * In-process cache of `PdnsClient` instances keyed by server id. The client
 * holds the decrypted API key plus the version-cache snapshot, so reusing
 * the instance across requests avoids both a key decrypt and (almost
 * always) a network round-trip for capability detection.
 *
 * Cache invalidation: the admin UI calls `invalidatePdnsClient(id)` whenever
 * a server row is updated or deleted. Servers can also be evicted manually
 * for tests via `clearPdnsClientRegistry()`.
 *
 * The registry imports from `lib/db/*` to read the server row and
 * `lib/crypto/*` to decrypt the API key. The ESLint import-boundary rule
 * forbids `lib/pdns/*` from depending on `lib/db/*`, so this module lives
 * one level up logically — it's the *bridge*, not the protocol client. To
 * keep the boundary clean we put the bridge in `lib/pdns/registry.ts` with
 * the understanding that future architectural refactors may move it to
 * `lib/servers/` or similar. For now an inline ESLint disable documents the
 * exception.
 */

/* eslint-disable no-restricted-imports -- Sanctioned lib/pdns→lib/db bridge:
   this module turns a `pdns_servers` row into a configured PdnsClient (reads
   the row, decrypts the API key). It is the bridge, not the protocol client.
   See ADR-0013. */
import "server-only";
import { decrypt } from "@/lib/crypto/encryption";
import {
  findPdnsServerById,
  listAllActiveBackends,
  setPdnsVersionCache,
} from "@/lib/db/repositories/pdns-servers";
import type { PdnsServer } from "@/lib/db/schema";

import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { PdnsClient } from "./client";

interface CachedEntry {
  client: PdnsClient;
  /** `updatedAt` of the row at the time we built the client. Used to detect drift. */
  builtFrom: number;
}

const registry = new Map<string, CachedEntry>();

/**
 * Return the `PdnsClient` for a given server row id. Builds + caches on
 * miss. If the row's `updatedAt` is newer than the cached entry, the cached
 * client is discarded and rebuilt (handles in-flight updates between cache
 * insert and next call).
 *
 * @throws {NotFoundError} when no server row matches `id`.
 */
export async function getPdnsClient(id: string): Promise<PdnsClient> {
  const row = await findPdnsServerById(id);
  if (!row) throw new NotFoundError(`PowerDNS server ${id} not found.`);
  return getPdnsClientForRow(row);
}

/**
 * Build (or fetch from cache) a `PdnsClient` for an already-loaded row.
 * Useful when the caller has the row in hand (e.g., from `listActivePdnsServers`)
 * and shouldn't re-fetch it.
 */
export function getPdnsClientForRow(row: PdnsServer): PdnsClient {
  const rowUpdatedAt = row.updatedAt.getTime();
  const cached = registry.get(row.id);
  if (cached?.builtFrom === rowUpdatedAt) {
    return cached.client;
  }

  const apiKey = decrypt(row.apiKeyEncrypted, "pdns-api-key");
  const client = new PdnsClient({
    baseUrl: row.baseUrl,
    apiKey,
    serverSlug: row.slug,
    serverId: row.serverId,
    serverDbId: row.id,
    initialVersionCache: row.versionCache ?? null,
  });
  registry.set(row.id, { client, builtFrom: rowUpdatedAt });
  return client;
}

/**
 * Evict a server's cached client. Call after any write to the row (slug,
 * url, key, default flag). Safe to call when the entry doesn't exist.
 */
export function invalidatePdnsClient(id: string): void {
  registry.delete(id);
}

/** Test-only: drop every cached client. */
export function clearPdnsClientRegistry(): void {
  registry.clear();
}

/**
 * Convenience for "fetch the version, persist if refreshed". Used by the
 * admin connection-test action and by background health checks.
 *
 * @returns the version snapshot and a `persisted` flag.
 */
export async function refreshAndPersistVersion(
  id: string,
): Promise<{ cache: Awaited<ReturnType<PdnsClient["version"]>>["cache"]; persisted: boolean }> {
  const client = await getPdnsClient(id);
  const { cache, refreshed } = await client.version();
  if (refreshed) {
    await setPdnsVersionCache(id, cache);
  }
  return { cache, persisted: refreshed };
}

/**
 * Force-refresh every active PDNS backend's version cache in
 * parallel. Mirror of the OIDC
 * `sampleAllOidcDiscoveryNow` (T-103). Returns `{probed, failed}` —
 * `probed` is the total number of active servers attempted,
 * `failed` is how many threw during refresh. Per-server failures
 * are caught and logged (the operator-facing Refresh-all route
 * doesn't need to know which specific row failed; the dashboard's
 * PDNS-attention widget + per-row highlight from T-109 surface
 * that).
 *
 * Useful after a backend fleet upgrade — operator clicks Refresh
 * all, every server's version_cache reflects the new state without
 * having to click Test on each row individually.
 */
export async function refreshAllPdnsVersionsNow(): Promise<{
  probed: number;
  failed: number;
}> {
  // Include every active backend regardless of role — Secondaries (and
  // multi-primary peers, which are role='primary' but conceptually part
  // of a cluster) all benefit from a fresh version_cache. Previously
  // this used `listActivePdnsServers()` which filters role='primary',
  // so the "Refresh all" button silently skipped Secondaries; the toast
  // would report "Re-probed 1 backend" on a 1-primary + 3-secondaries
  // stack, which read like a bug to operators.
  const servers = await listAllActiveBackends();
  const outcomes = await Promise.all(
    servers.map((s) =>
      refreshAndPersistVersion(s.id).then(
        () => true as const,
        (err: unknown) => {
          logger.warn(
            {
              serverId: s.id,
              serverSlug: s.slug,
              err: err instanceof Error ? err.message : "unknown",
            },
            "pdns.version.refresh-all.server-failed",
          );
          return false as const;
        },
      ),
    ),
  );
  return {
    probed: servers.length,
    failed: outcomes.filter((ok) => !ok).length,
  };
}
