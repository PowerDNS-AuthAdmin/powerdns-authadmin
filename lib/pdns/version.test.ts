/**
 * lib/pdns/version.test.ts — version-parse + capability-cutoff coverage.
 *
 * The cutoffs encode — get them wrong and we'd silently
 * fall back to REPLACE semantics (the older systems concurrency footgun) on
 * servers that actually support EXTEND/PRUNE.
 */

import { describe, expect, it } from "vitest";
import { buildVersionCache, isVersionCacheFresh } from "./version";

describe("buildVersionCache", () => {
  it("flags EXTEND/PRUNE on 4.9.12 exactly", () => {
    const cache = buildVersionCache("4.9.12", "localhost");
    expect(cache.parsed).toEqual({ major: 4, minor: 9, patch: 12 });
    expect(cache.capabilities.supportsExtendPrune).toBe(true);
  });

  it("rejects EXTEND/PRUNE on 4.9.11", () => {
    const cache = buildVersionCache("4.9.11", "localhost");
    expect(cache.capabilities.supportsExtendPrune).toBe(false);
  });

  it("flags EXTEND/PRUNE on 5.0.2 (5.x branch cutoff)", () => {
    const cache = buildVersionCache("5.0.2", "localhost");
    expect(cache.capabilities.supportsExtendPrune).toBe(true);
  });

  it("rejects EXTEND/PRUNE on 5.0.1", () => {
    const cache = buildVersionCache("5.0.1", "localhost");
    expect(cache.capabilities.supportsExtendPrune).toBe(false);
  });

  it("flags catalog zones on 4.7+", () => {
    expect(buildVersionCache("4.7.0", "localhost").capabilities.supportsCatalogZones).toBe(true);
    expect(buildVersionCache("4.6.9", "localhost").capabilities.supportsCatalogZones).toBe(false);
  });

  it("flags views on 5.0+", () => {
    expect(buildVersionCache("5.0.0", "localhost").capabilities.supportsViews).toBe(true);
    expect(buildVersionCache("4.9.12", "localhost").capabilities.supportsViews).toBe(false);
  });

  it("flags the TSIG API on 4.1+", () => {
    expect(buildVersionCache("4.1.0", "localhost").capabilities.supportsTsigApi).toBe(true);
    expect(buildVersionCache("4.6.0", "localhost").capabilities.supportsTsigApi).toBe(true);
    expect(buildVersionCache("4.0.5", "localhost").capabilities.supportsTsigApi).toBe(false);
  });

  it("falls back to all-off on an unparseable version string", () => {
    const cache = buildVersionCache("garbage", "localhost");
    expect(cache.parsed).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(cache.capabilities.supportsExtendPrune).toBe(false);
    expect(cache.capabilities.supportsCatalogZones).toBe(false);
    expect(cache.capabilities.supportsViews).toBe(false);
    expect(cache.capabilities.supportsTsigApi).toBe(false);
  });

  it("tolerates suffixes (commit hash, dev tag)", () => {
    const cache = buildVersionCache("5.0.4-dev+commit", "localhost");
    expect(cache.parsed).toEqual({ major: 5, minor: 0, patch: 4 });
    expect(cache.capabilities.supportsViews).toBe(true);
  });
});

describe("isVersionCacheFresh", () => {
  it("returns false when no cache exists", () => {
    expect(isVersionCacheFresh(null, 1000)).toBe(false);
  });

  it("returns true when fetched within TTL", () => {
    const cache = buildVersionCache("5.0.0", "localhost");
    expect(isVersionCacheFresh(cache, 60_000)).toBe(true);
  });

  it("returns false when older than TTL", () => {
    const cache = {
      ...buildVersionCache("5.0.0", "localhost"),
      fetchedAt: new Date(Date.now() - 10_000).toISOString(),
    };
    expect(isVersionCacheFresh(cache, 1_000)).toBe(false);
  });
});
