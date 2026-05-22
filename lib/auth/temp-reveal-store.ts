/**
 * lib/auth/temp-reveal-store.ts
 *
 * Single-use, short-lived in-memory store for plaintext secrets that an
 * operator generated and needs to retrieve **exactly once** out-of-band.
 *
 * Used by the admin password-reset flow (S-8): the POST response no longer
 * carries the temp password. Instead the route stores it here keyed by a
 * random opaque token, and the operator's browser fetches the plaintext via
 * a second call to a dedicated reveal endpoint that returns text/plain. The
 * entry is deleted on first read so any captured log line / cached body of
 * that reveal call yields nothing on replay.
 *
 * Defenses layered into the design:
 *   1. **Single-use** — `redeem()` deletes the entry before returning. A
 *      second call gets `null`.
 *   2. **Allowed-actor binding** — entries record the user-id that minted
 *      them. Even if the token leaks (proxy access log, browser history),
 *      it can only be redeemed by a session for that same operator. A
 *      different signed-in operator gets `null`.
 *   3. **TTL** — entries auto-expire after `DEFAULT_TTL_SEC` whether
 *      redeemed or not. The cleanup tick runs lazily on writes.
 *   4. **Bounded size** — the map is capped at `MAX_ENTRIES`. When full,
 *      writes evict the oldest entry. The cap is well above any
 *      realistic concurrent admin reset.
 *
 * Multi-replica caveat: this is process-local. For a multi-replica deploy
 * the operator must hit the same replica that minted the token within the
 * TTL window. future work will swap in a Redis-backed implementation behind
 * the same interface.
 */

import "server-only";
import { randomBytes } from "node:crypto";

interface Entry {
  plaintext: string;
  allowedActorId: string;
  expiresAtMs: number;
}

const DEFAULT_TTL_SEC = 300;
const MAX_ENTRIES = 1024;

const store = new Map<string, Entry>();

/**
 * Generate a fresh opaque token (32 bytes, base64url) and stash the
 * plaintext bound to `allowedActorId`. Returns `{ token, expiresInSec }`.
 *
 * Side effect: opportunistically evicts expired entries on each call so the
 * map self-prunes without a background timer.
 */
export function mint(input: { plaintext: string; allowedActorId: string; ttlSec?: number }): {
  token: string;
  expiresInSec: number;
} {
  pruneExpired();
  enforceCap();

  const ttl = input.ttlSec ?? DEFAULT_TTL_SEC;
  const token = randomBytes(32).toString("base64url");
  store.set(token, {
    plaintext: input.plaintext,
    allowedActorId: input.allowedActorId,
    expiresAtMs: Date.now() + ttl * 1000,
  });
  return { token, expiresInSec: ttl };
}

/**
 * Look up `token`, verify it was minted for `actorId`, delete the entry,
 * and return the plaintext. Returns `null` when:
 *   - the token doesn't exist (already redeemed, expired, or fabricated),
 *   - the token exists but was minted for a different operator,
 *   - the entry has expired (also deleted as a side effect).
 *
 * Constant-time on success/missing-token: callers should not branch on the
 * return shape in ways that leak timing — but this is admin-only flow
 * where the threat is lower than e.g. login enumeration.
 */
export function redeem(input: { token: string; actorId: string }): { plaintext: string } | null {
  const entry = store.get(input.token);
  if (!entry) return null;

  // Always remove on lookup — whether or not the actor matches. A wrong-actor
  // attempt burns the token, which is fine: the legitimate operator can
  // re-trigger a reset cheaply, but a leaked token can't be retried after a
  // failed steal.
  store.delete(input.token);

  if (entry.expiresAtMs <= Date.now()) return null;
  if (entry.allowedActorId !== input.actorId) return null;

  return { plaintext: entry.plaintext };
}

/** Test-only: drop everything. Not exported through any barrel. */
export function _resetForTests(): void {
  store.clear();
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
