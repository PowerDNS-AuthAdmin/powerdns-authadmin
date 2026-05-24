/**
 * lib/realtime/tsig-presence.ts
 *
 * Tracks, per secondary backend, how many TSIG keys it is MISSING that its
 * primary replicated to the rest of the group (ADR-0015 missing-key rule). The
 * poll recomputes this cross-backend each daemon-refresh cycle (it needs every
 * backend's `GET /tsigkeys` listing at once) and calls `setTsigMissingCounts`;
 * the health evaluator reads `getTsigMissingCount` and alerts when > 0.
 *
 * State lives on `globalThis` (same survives-bundle-duplication reason as the
 * zone-state + topology + drift caches), and lives HERE rather than inside the
 * poller so the central single-backend health op can read the same count without
 * importing the poller (which would be a cycle) — otherwise an explicit
 * Test/Refresh would prune a missing-key advisory the poll had set.
 */

import "server-only";

declare global {
  var __pdnsTsigMissing: Map<string, number> | undefined;
}
const current = (): Map<string, number> =>
  (globalThis.__pdnsTsigMissing ??= new Map<string, number>());

/**
 * Replace the missing-key counts from a fresh cross-backend computation. Only
 * the daemon-refresh cadence recomputes (a `GET /tsigkeys` per backend), so the
 * map persists between recomputes — non-refresh cycles keep the last counts so
 * the advisory doesn't flap.
 */
export function setTsigMissingCounts(counts: ReadonlyMap<string, number>): void {
  const next = new Map<string, number>();
  for (const [id, n] of counts) if (n > 0) next.set(id, n);
  globalThis.__pdnsTsigMissing = next;
}

/** How many replicated keys this secondary is missing (0 if none / unknown). */
export function getTsigMissingCount(backendId: string): number {
  return current().get(backendId) ?? 0;
}
