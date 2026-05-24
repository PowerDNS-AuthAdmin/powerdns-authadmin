/**
 * lib/auth/temp-reveal-store.ts
 *
 * Single-use, short-lived store for plaintext secrets an operator generated and
 * needs to retrieve **exactly once** out-of-band (admin password reset S-8, TSIG
 * key secret, PAT, TOTP secret). The minting route stashes the plaintext keyed
 * by a random opaque token; the operator's browser fetches it via a dedicated
 * reveal endpoint that returns text/plain and the entry is deleted on first read.
 *
 * Defenses (identical across both backends below):
 *   1. **Single-use** — `redeem()` deletes before returning. A second call → null.
 *   2. **Allowed-actor binding** — entries record the minting user-id; a leaked
 *      token can only be redeemed by a session for that same operator.
 *   3. **TTL** — entries auto-expire after `DEFAULT_TTL_SEC`.
 *   4. **Bounded size** — the in-memory map is capped (Redis self-expires).
 *
 * Backend (ADR-0016): when `REDIS_URL` is set the entry lives in Redis (atomic
 * `SET … PX` + single-use `GETDEL`), so a token minted on replica A is
 * redeemable on replica B — essential for HA, where the reveal call may land on
 * a different replica than the mint. Without Redis (single instance) it's an
 * in-process Map. A Redis error degrades to the in-process Map (same-replica
 * only) rather than failing the mint outright.
 */

import "server-only";
import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { logger } from "@/lib/logger";

interface Entry {
  plaintext: string;
  allowedActorId: string;
  expiresAtMs: number;
}

const DEFAULT_TTL_SEC = 300;
const MAX_ENTRIES = 1024;
const REDIS_PREFIX = "reveal:";

const store = new Map<string, Entry>();

/**
 * Generate a fresh opaque token (32 bytes, base64url) and stash the plaintext
 * bound to `allowedActorId`. Uses Redis when configured (cross-replica), else
 * the in-process map; a Redis failure falls back to the map.
 */
export async function mint(input: {
  plaintext: string;
  allowedActorId: string;
  ttlSec?: number;
}): Promise<{ token: string; expiresInSec: number }> {
  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const token = randomBytes(32).toString("base64url");

  const redis = getRedis();
  if (redis) {
    try {
      await redis.set(
        REDIS_PREFIX + token,
        JSON.stringify({ plaintext: input.plaintext, allowedActorId: input.allowedActorId }),
        "PX",
        ttl * 1000,
      );
      return { token, expiresInSec: ttl };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "reveal-store.redis.mint.failed",
      );
      // fall through to the in-process map (same-replica only)
    }
  }

  mintLocal(token, input.plaintext, input.allowedActorId, ttl);
  return { token, expiresInSec: ttl };
}

/**
 * Look up `token`, verify it was minted for `actorId`, delete the entry, and
 * return the plaintext. Returns `null` for a missing/expired/already-redeemed
 * token or an actor mismatch. The token is burned on any attempt (wrong actor
 * included), so a leaked token can't be retried after a failed steal.
 */
export async function redeem(input: {
  token: string;
  actorId: string;
}): Promise<{ plaintext: string } | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const raw = await redis.getdel(REDIS_PREFIX + input.token); // atomic single-use
      if (raw !== null) {
        const entry = JSON.parse(raw) as { plaintext: string; allowedActorId: string };
        if (entry.allowedActorId !== input.actorId) return null;
        return { plaintext: entry.plaintext };
      }
      // Not in Redis — may be a same-replica fallback entry from a mint-time blip.
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "reveal-store.redis.redeem.failed",
      );
    }
  }
  return redeemLocal(input.token, input.actorId);
}

/** Test-only: drop the in-process map. Not exported through any barrel. */
export function _resetForTests(): void {
  store.clear();
}

// ---------------------------------------------------------------------------
// In-process backend (single instance / Redis-outage fallback)
// ---------------------------------------------------------------------------

function mintLocal(token: string, plaintext: string, allowedActorId: string, ttlSec: number): void {
  pruneExpired();
  enforceCap();
  store.set(token, { plaintext, allowedActorId, expiresAtMs: Date.now() + ttlSec * 1000 });
}

function redeemLocal(token: string, actorId: string): { plaintext: string } | null {
  const entry = store.get(token);
  if (!entry) return null;
  // Always remove on lookup — a wrong-actor attempt still burns the token.
  store.delete(token);
  if (entry.expiresAtMs <= Date.now()) return null;
  if (entry.allowedActorId !== actorId) return null;
  return { plaintext: entry.plaintext };
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [k, v] of store) {
    if (v.expiresAtMs <= now) store.delete(k);
  }
}

function enforceCap(): void {
  while (store.size >= MAX_ENTRIES) {
    // Map iteration order is insertion order — the first key is the oldest.
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}
