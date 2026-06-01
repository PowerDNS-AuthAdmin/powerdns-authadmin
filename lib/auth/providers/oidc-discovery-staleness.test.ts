import { describe, expect, it } from "vitest";
import { isDiscoveryCacheStale } from "./oidc-discovery-staleness";

describe("isDiscoveryCacheStale", () => {
  // Fixed `now` so the assertions don't drift with wall clock.
  const NOW = Date.parse("2026-05-17T10:00:00.000Z");
  const STALE_15_MIN = 15 * 60 * 1000;

  it("returns true when the cache is null (never probed)", () => {
    expect(isDiscoveryCacheStale(null, STALE_15_MIN, NOW)).toBe(true);
  });

  it("returns false when the cache is fresh", () => {
    // 10 minutes ago - well under 15-minute staleness.
    const cache = {
      fetchedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      ok: true,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN, NOW)).toBe(false);
  });

  it("returns true when the cache is exactly at the threshold + 1ms", () => {
    const cache = {
      fetchedAt: new Date(NOW - STALE_15_MIN - 1).toISOString(),
      ok: true,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN, NOW)).toBe(true);
  });

  it("returns false at exactly the threshold (boundary is exclusive)", () => {
    // Now - staleMs = boundary; > staleMs is stale, == is not.
    const cache = {
      fetchedAt: new Date(NOW - STALE_15_MIN).toISOString(),
      ok: true,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN, NOW)).toBe(false);
  });

  it("treats a failed-probe cache the same as a successful one for freshness", () => {
    // The freshness predicate doesn't care about ok=true/false -
    // a failed attempt 5 minutes ago is still "we tried 5m ago"
    // and shouldn't be re-probed before staleness elapses. This
    // pins the design choice and prevents a future "re-probe
    // failures more aggressively" change from sneaking in
    // without a refactor.
    const cache = {
      fetchedAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
      ok: false,
      reason: "transport" as const,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN, NOW)).toBe(false);
  });

  it("returns true for a cache with an unparseable fetchedAt timestamp", () => {
    // Defensive: a corrupted JSONB cache (someone hand-edited it)
    // shouldn't make the predicate hang on NaN; it should fall
    // back to "stale" so the next sample tick repairs the row.
    const cache = {
      fetchedAt: "not-a-date",
      ok: true,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN, NOW)).toBe(true);
  });

  it("uses Date.now() when `now` is omitted", () => {
    // Smoke test for the default param: a cache from way in the
    // past must be stale under wall-clock now.
    const cache = {
      fetchedAt: "2020-01-01T00:00:00.000Z",
      ok: true,
    };
    expect(isDiscoveryCacheStale(cache, STALE_15_MIN)).toBe(true);
  });
});
