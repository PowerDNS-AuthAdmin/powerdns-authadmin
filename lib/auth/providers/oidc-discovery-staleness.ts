/**
 * lib/auth/providers/oidc-discovery-staleness.ts
 *
 * Pure staleness predicate for the OIDC discovery cache.
 * Lives in its own file rather than alongside the sampler so unit
 * tests can import it without pulling in `lib/db` (which loads `pg`,
 * which has CJS/ESM interop quirks the unit config doesn't address).
 * Same separation pattern as `lib/freshness.ts` (extracted from
 * `lib/pdns/` in T-77).
 */

export function isDiscoveryCacheStale(
  cache: { fetchedAt: string; ok: boolean; reason?: string } | null,
  staleMs: number,
  now: number = Date.now(),
): boolean {
  if (!cache) return true;
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs)) return true;
  return now - fetchedMs > staleMs;
}
