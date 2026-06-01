/**
 * lib/auth/rate-limit.ts
 *
 * Token-bucket rate limiter. `take()` is the per-process in-memory path;
 * `takeShared()` is the same bucket coordinated across replicas via Redis when
 * `REDIS_URL` is set (ADR-0016), falling back to in-process when Redis is unset
 * OR a command fails - so login throttling can't be multiplied by spreading
 * attempts across replicas, yet a Redis blip never blocks sign-in. The
 * per-account DB lockout (`recordFailedLogin`) is the second line for
 * distributed attacks.
 *
 * Why we wrote our own bucket instead of pulling a dep: the in-memory contract
 * is ~30 lines with an explicit, time-bounded eviction policy; the Redis path is
 * one atomic Lua script.
 */

import "server-only";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

/**
 * Atomic token-bucket refill+take in one round trip (no read-modify-write race
 * across replicas). KEYS[1]=bucket; ARGV = capacity, refillPerSec, nowMs.
 * Returns {allowed(0|1), retryAfterSeconds}. The key self-expires after a full
 * refill window so idle identifiers don't accumulate.
 */
const TOKEN_BUCKET_LUA = `
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
local cap = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if tokens == nil then tokens = cap; ts = now end
local elapsed = (now - ts) / 1000.0
tokens = math.min(cap, tokens + elapsed * rate)
ts = now
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], math.ceil((cap / rate) * 1000) + 1000)
return {allowed, retry}
`;

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

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

  /** Hard cap on the in-memory map size - prevents memory exhaustion. */
  private readonly MAX_KEYS = 50_000;

  constructor(opts: LimiterOptions) {
    this.opts = opts;
  }

  /**
   * Take one token from the PER-PROCESS bucket. Use for non-security-critical,
   * high-volume limiters (e.g. CSP reports) where cross-replica accuracy doesn't
   * matter; security endpoints use `takeShared`.
   */
  take(key: string): RateLimitResult {
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

  /**
   * Take one token from the bucket SHARED across replicas via Redis (when
   * configured) - the cross-replica limit. Falls back to the per-process `take`
   * when Redis is unset or a command fails (degraded but never blocking).
   */
  async takeShared(key: string): Promise<RateLimitResult> {
    const redis = getRedis();
    if (!redis) return this.take(key);
    try {
      const res = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        `ratelimit:${key}`,
        String(this.opts.capacity),
        String(this.opts.refillPerSec),
        String(Date.now()),
      )) as [number, number];
      return res[0] === 1 ? { allowed: true } : { allowed: false, retryAfterSeconds: res[1] };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "ratelimit.redis.failed",
      );
      return this.take(key);
    }
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
