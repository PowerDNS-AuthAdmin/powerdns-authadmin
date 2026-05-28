/**
 * lib/auth/providers/idp-perms-cache.ts
 *
 * In-memory TTL cache for IdP-derived permissions on the token-auth
 * path. Keyed by `(userId | providerType:providerSlug)`, stores a
 * frozen `AbilitySource[]` snapshot plus an `expiresAt`.
 *
 * Why in-memory: a burst of API token calls from the same user
 * shouldn't hammer the IdP (LDAP service-account search every request
 * → directory operations; OIDC `refresh_token → userinfo` round-trip
 * every request → external network). The cache absorbs the burst at
 * the cost of `IDP_PERMS_CACHE_TTL_SECONDS` of staleness.
 *
 * Why per-process (not Redis-shared): even at scale the staleness is
 * bounded by the TTL, and the per-replica copies converge within one
 * TTL of any group change at the IdP. The complexity of a shared cache
 * isn't worth the marginal accuracy improvement.
 *
 * Eviction: lazy — we check `expiresAt` on each read. A pathological
 * workload (large user count, all signed in via LDAP/OIDC) could let
 * the map grow without bound; in practice the user population is
 * small and the entries are tiny. If that ever changes, plug in a
 * size cap.
 */

import "server-only";
import { env } from "@/lib/env";
import type { AbilitySource } from "@/lib/rbac/ability";

interface CacheEntry {
  sources: readonly AbilitySource[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function keyFor(userId: string, providerType: string, providerSlug: string): string {
  return `${userId}|${providerType}:${providerSlug}`;
}

/**
 * Read a cached snapshot. Returns null when missing OR when the entry
 * is past its TTL — caller treats both the same: recompute via the
 * provider's live path, then `putIdpPerms` the result.
 */
export function getIdpPerms(
  userId: string,
  providerType: string,
  providerSlug: string,
): readonly AbilitySource[] | null {
  const key = keyFor(userId, providerType, providerSlug);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.sources;
}

/**
 * Insert a fresh recompute result. TTL is `IDP_PERMS_CACHE_TTL_SECONDS`
 * from now. Pass an empty array to record a "no group memberships /
 * no mappings matched" result — that's a valid cache entry, not the
 * absence of one.
 */
export function putIdpPerms(
  userId: string,
  providerType: string,
  providerSlug: string,
  sources: readonly AbilitySource[],
): void {
  const ttlMs = env.IDP_PERMS_CACHE_TTL_SECONDS * 1000;
  cache.set(keyFor(userId, providerType, providerSlug), {
    sources,
    expiresAt: Date.now() + ttlMs,
  });
}

/**
 * Drop one user's cache entry (any provider). Called when admin
 * actions intentionally diverge a user's perms (force re-sync, sign
 * out everywhere, etc) — without this the in-memory snapshot would
 * keep serving stale rows for up to `IDP_PERMS_CACHE_TTL_SECONDS`.
 */
export function invalidateIdpPermsForUser(userId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${userId}|`)) cache.delete(key);
  }
}

/** Test-only: drop the whole cache. */
export function __resetIdpPermsCacheForTests(): void {
  cache.clear();
}
