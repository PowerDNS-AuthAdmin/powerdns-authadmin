/**
 * lib/realtime/replication-drift.ts
 *
 * Tracks, per backend, how long it has CONTINUOUSLY lagged its primary's serial
 * (ADR-0015 drift rule). The poll recomputes the not-synced set each cycle and
 * calls `updateDriftDurations`; the health evaluator reads `getReplicationDriftMs`
 * and only alerts past `DRIFT_THRESHOLD_MS`, so a transient AXFR never trips it.
 *
 * State lives on `globalThis` (same survives-bundle-duplication reason as the
 * zone-state + topology caches), and lives HERE rather than inside the poller so
 * the central single-backend health op can read the same drift without importing
 * the poller (which would be a cycle).
 */

import "server-only";

declare global {
  var __pdnsDriftSince: Map<string, number> | undefined;
}
const current = (): Map<string, number> =>
  (globalThis.__pdnsDriftSince ??= new Map<string, number>());

/**
 * Rebuild the drift-start map from this cycle's not-synced set and return how
 * long each currently-lagging backend has lagged (ms). Rebuilding from the set
 * prunes both caught-up and deleted backends.
 */
export function updateDriftDurations(
  notSynced: ReadonlySet<string>,
  now: number,
): Map<string, number> {
  const prev = current();
  const next = new Map<string, number>();
  const durations = new Map<string, number>();
  for (const id of notSynced) {
    const since = prev.get(id) ?? now;
    next.set(id, since);
    durations.set(id, now - since);
  }
  globalThis.__pdnsDriftSince = next;
  return durations;
}

/**
 * How long this backend has continuously lagged its primary (ms), or null if in
 * sync / not comparable. Read by the out-of-cycle health refresh (an explicit
 * Test) so it evaluates the same drift the poll would — never spuriously pruning
 * an active drift advisory.
 */
export function getReplicationDriftMs(backendId: string): number | null {
  const since = current().get(backendId);
  return since === undefined ? null : Date.now() - since;
}
