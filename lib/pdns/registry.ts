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
 * one level up logically - it's the *bridge*, not the protocol client. To
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
import { findPdnsServerById } from "@/lib/db/repositories/pdns-servers";
import type { PdnsServer } from "@/lib/db/schema";

import { NotFoundError } from "@/lib/errors";
import { PdnsClient } from "./client";

interface CachedEntry {
  client: PdnsClient;
  /** `updatedAt` of the row at the time we built the client. Used to detect drift. */
  builtFrom: number;
}

/**
 * Probe clients (the background poll + explicit Test/Refresh health checks) fail
 * fast: a SINGLE attempt with a short timeout. An unreachable backend then
 * resolves to "down" in ~5s instead of the ~30s a write-path client spends on
 * 3 attempts × 10s - which otherwise wedges the zones/servers pages (they await
 * the poll) and stalls the Test toast. Interactive reads/writes (via
 * `backend-gateway`) keep the default resilience; the poll cadence is the retry
 * for a transient blip here.
 */
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_ATTEMPTS = 1;

const registry = new Map<string, CachedEntry>();
const probeRegistry = new Map<string, CachedEntry>();

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
function buildClient(row: PdnsServer, probe: boolean): PdnsClient {
  const apiKey = decrypt(row.apiKeyEncrypted, "pdns-api-key");
  return new PdnsClient({
    baseUrl: row.baseUrl,
    apiKey,
    serverSlug: row.slug,
    serverId: row.serverId,
    serverDbId: row.id,
    initialVersionCache: row.versionCache ?? null,
    // Probe clients (the background poll) also route their READS through the
    // per-backend lock, so the poll takes turns with the request path's writes
    // instead of contending on the backend's store (ADR-0017 follow-up).
    ...(probe
      ? {
          maxAttempts: PROBE_MAX_ATTEMPTS,
          timeoutMs: PROBE_TIMEOUT_MS,
          coordinateAllRequests: true,
        }
      : {}),
  });
}

export function getPdnsClientForRow(row: PdnsServer): PdnsClient {
  const rowUpdatedAt = row.updatedAt.getTime();
  const cached = registry.get(row.id);
  if (cached?.builtFrom === rowUpdatedAt) {
    return cached.client;
  }

  const client = buildClient(row, false);
  registry.set(row.id, { client, builtFrom: rowUpdatedAt });
  return client;
}

/**
 * Fast-fail client for observation/health probes (the background poll + the
 * explicit Test/Refresh). Single attempt, short timeout - see `PROBE_TIMEOUT_MS`.
 * NEVER use for a user-initiated read/write; those go through `backend-gateway`
 * and keep the default retry resilience.
 */
export function getPdnsProbeClientForRow(row: PdnsServer): PdnsClient {
  const rowUpdatedAt = row.updatedAt.getTime();
  const cached = probeRegistry.get(row.id);
  if (cached?.builtFrom === rowUpdatedAt) {
    return cached.client;
  }

  const client = buildClient(row, true);
  probeRegistry.set(row.id, { client, builtFrom: rowUpdatedAt });
  return client;
}

/**
 * Evict a server's cached clients (both the write and probe variants). Call
 * after any write to the row (slug, url, key, default flag). Safe to call when
 * the entry doesn't exist.
 */
export function invalidatePdnsClient(id: string): void {
  registry.delete(id);
  probeRegistry.delete(id);
}

/** Test-only: drop every cached client. */
export function clearPdnsClientRegistry(): void {
  registry.clear();
  probeRegistry.clear();
}

// The per-backend daemon snapshot refresh (version + capabilities + reachability
// + advisory) lives in `lib/realtime/backend-health.ts` - the ONE central health
// op shared by the poll and every explicit refresh. The registry stays a pure
// client cache; it no longer owns a separate probe path.
