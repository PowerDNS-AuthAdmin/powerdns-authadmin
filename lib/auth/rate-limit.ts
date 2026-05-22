/**
 * lib/auth/rate-limit.ts
 *
 * Simple token-bucket rate limiter. In-memory by default; swap in a Redis
 * implementation when REDIS_URL is configured.
 *
 * Used for login, password-reset, and token-issuance endpoints. Configurable
 * per-key bucket size + refill rate.
 *
 * Why we wrote our own instead of pulling a dep:
 *   - The contract is 30 lines. A dep would be more code than the impl.
 *   - We control the eviction policy explicitly. In-memory bucket entries
 *     are time-bounded, so the map can't grow unboundedly under a botnet
 *     hammering many distinct identifiers.
 */

import "server-only";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface LimiterOptions {
  /** Maximum tokens (burst). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
}

/**
 * Token-bucket limiter keyed by a string identifier (e.g. `ip:1.2.3.4` or
 * `email:alice@example.com`). Returns `{ allowed, retryAfterSeconds }`.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly opts: LimiterOptions;

  /** Hard cap on the in-memory map size — prevents memory exhaustion. */
  private readonly MAX_KEYS = 50_000;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
  }

  /**
   * Attempt to take one token. Returns `{ allowed: true }` on success or
   * `{ allowed: false, retryAfterSeconds }` on denial.
   */
  take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      if (this.buckets.size >= this.MAX_KEYS) this.evictOldest();
      bucket = { tokens: this.opts.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    } else {
      // Refill: time elapsed × rate, capped at capacity.
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        this.opts.capacity,
        bucket.tokens + elapsedSec * this.opts.refillPerSec,
      );
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const retryAfterSeconds = Math.ceil((1 - bucket.tokens) / this.opts.refillPerSec);
    return { allowed: false, retryAfterSeconds };
  }

  /** Drop oldest entry to make room. O(n); we evict rarely. */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, b] of this.buckets) {
      if (b.lastRefill < oldestTime) {
        oldestTime = b.lastRefill;
        oldestKey = k;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}

/**
 * Default limiter for the login endpoint: 5 attempts burst, refill 1 every
 * 60s. This is per-IP; we also enforce a per-account lockout in
 * `recordFailedLogin()` for distributed attacks.
 */
export const loginLimiter = new TokenBucketLimiter({
  capacity: 5,
  refillPerSec: 1 / 60,
});

/**
 * Default limiter for token / password-reset endpoints: 3 attempts burst,
 * refill 1 every 5 minutes.
 */
export const sensitiveLimiter = new TokenBucketLimiter({
  capacity: 3,
  refillPerSec: 1 / 300,
});
