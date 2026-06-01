/**
 * lib/auth/rate-limit.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucketLimiter } from "./rate-limit";

// Mocked so `takeShared` can be steered between "no Redis", "Redis ok", and
// "Redis throws" without a live server. The factory returns a stub we reach
// for via the typed import below.
vi.mock("@/lib/redis", () => ({
  getRedis: vi.fn(() => null),
}));
import { getRedis } from "@/lib/redis";
const getRedisMock = vi.mocked(getRedis);

describe("TokenBucketLimiter", () => {
  it("allows up to capacity in a burst", () => {
    const lim = new TokenBucketLimiter({ capacity: 3, refillPerSec: 0.001 });
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(false);
  });

  it("isolates keys", () => {
    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.001 });
    expect(lim.take("a").allowed).toBe(true);
    expect(lim.take("b").allowed).toBe(true);
    expect(lim.take("a").allowed).toBe(false);
  });

  it("returns a positive retryAfter on denial", () => {
    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.001 });
    lim.take("k");
    const r = lim.take("k");
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});

describe("TokenBucketLimiter refill over time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refills one token after enough wall-clock has elapsed", () => {
    // 1 token / second so a single advance of 1s restores exactly one token.
    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    expect(lim.take("k").allowed).toBe(true); // drains the bucket
    expect(lim.take("k").allowed).toBe(false); // empty

    vi.advanceTimersByTime(1_000); // +1 token
    expect(lim.take("k").allowed).toBe(true); // refilled
    expect(lim.take("k").allowed).toBe(false); // drained again
  });

  it("caps the refill at capacity (no over-accumulation while idle)", () => {
    const lim = new TokenBucketLimiter({ capacity: 2, refillPerSec: 1 });
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(false);

    // Idle for far longer than it takes to refill the whole bucket.
    vi.advanceTimersByTime(60_000);
    // Only `capacity` tokens are available - not 60.
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(true);
    expect(lim.take("k").allowed).toBe(false);
  });
});

describe("TokenBucketLimiter MAX_KEYS eviction", () => {
  it("keeps the in-memory map bounded by evicting the oldest entry", () => {
    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.001 });
    // Reach into the private cap so the test doesn't have to insert 50k keys.
    const internals = lim as unknown as {
      MAX_KEYS: number;
      buckets: Map<string, unknown>;
    };
    // MAX_KEYS is `readonly` on the instance; override it for the test.
    Object.defineProperty(internals, "MAX_KEYS", { value: 3, configurable: true });

    lim.take("k0"); // oldest
    lim.take("k1");
    lim.take("k2"); // map now at the cap of 3
    expect(internals.buckets.size).toBe(3);

    // Inserting a 4th distinct key triggers evictOldest before insert.
    lim.take("k3");
    expect(internals.buckets.size).toBe(3);
    // The oldest (k0) is the one dropped; the newcomer is present.
    expect(internals.buckets.has("k0")).toBe(false);
    expect(internals.buckets.has("k3")).toBe(true);
  });
});

describe("TokenBucketLimiter takeShared fallback", () => {
  beforeEach(() => {
    getRedisMock.mockReset();
  });

  it("falls back to in-process take() when Redis is null", async () => {
    getRedisMock.mockReturnValue(null);
    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.001 });
    expect((await lim.takeShared("k")).allowed).toBe(true);
    // Second call hits the same in-process bucket and is denied.
    expect((await lim.takeShared("k")).allowed).toBe(false);
  });

  it("falls back to in-process take() when redis.eval throws (Redis outage)", async () => {
    // The guarantee: a Redis outage degrades to per-process limiting, it does
    // NOT lock everyone out by surfacing the error.
    const evalMock = vi.fn().mockRejectedValue(new Error("connection refused"));
    getRedisMock.mockReturnValue({ eval: evalMock } as never);

    const lim = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.001 });
    const first = await lim.takeShared("k");
    expect(first.allowed).toBe(true); // didn't throw; degraded to take()
    expect(evalMock).toHaveBeenCalledOnce();

    // The fallback used the in-process bucket, so the next call is denied.
    expect((await lim.takeShared("k")).allowed).toBe(false);
  });
});
