/**
 * lib/pdns/backend-lock.ts
 *
 * Per-backend request coordination. The app talks to a backend from two places
 * at once - the background poll (reads) and the request path (writes) - and
 * against a single-file store (gsqlite3) a reader can stall a writer long enough
 * that PowerDNS returns a 500. We own both sides, so rather than tuning the
 * backend we make the app take turns: at most one *coordinated* operation per
 * backend runs at a time.
 *
 * Scope is deliberately narrow (see `lib/pdns/http.ts`): WRITE requests and the
 * poll's probe reads pass through the lock; ordinary interactive reads do NOT,
 * so a busy multi-user deployment keeps full read concurrency. Different
 * backends never block each other - the lock is keyed per backend.
 *
 * Implementation: a promise chain per key (a fair FIFO async mutex). The map
 * lives on globalThis so Next's per-route bundle duplication can't create two
 * independent locks for the same backend.
 */

import "server-only";

declare global {
  var __pdnsBackendLocks: Map<string, Promise<void>> | undefined;
}

const tails = (globalThis.__pdnsBackendLocks ??= new Map<string, Promise<void>>());

/**
 * Run `fn` with exclusive access to `key`'s slot. Callers queue FIFO; a thrown
 * `fn` still releases the slot. Other keys proceed in parallel.
 */
export async function withBackendLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const ours = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The next caller waits for the previous tail AND for us to release.
  const newTail = prev.then(() => ours);
  tails.set(key, newTail);

  await prev.catch(() => undefined); // our turn (ignore an earlier holder's error)
  try {
    return await fn();
  } finally {
    release();
    // If nobody queued behind us, drop the entry so the map can't grow without
    // bound across the lifetime of the process.
    if (tails.get(key) === newTail) tails.delete(key);
  }
}
