/**
 * lib/auth/rate-limit.test.ts
 */

import { describe, expect, it } from "vitest";
import { TokenBucketLimiter } from "./rate-limit";

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
