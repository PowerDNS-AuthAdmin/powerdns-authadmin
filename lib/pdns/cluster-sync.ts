/**
 * lib/pdns/cluster-sync.ts
 *
 * Pure multi-primary sync evaluator.
 *
 * The model: a multi-primary cluster has N peers whose underlying storage
 * replicates between them. After the app sends a write to ONE peer (per the
 * cluster's write strategy), there's a brief gap before the other peers pick
 * up the change. During that gap the post-write serial from the
 * peer-that-took-the-write is the source-of-truth — every other peer is
 * expected to converge to it.
 *
 * `evaluateClusterSync` takes that expected serial (or null in steady state)
 * plus each peer's observed serial and returns the UI's "synced / converging
 * / diverged" verdict. Pure — no I/O, no cache — so the caller owns where the
 * expected serial comes from and the chip logic stays unit-testable.
 */

import "server-only";

export type ClusterSyncVerdict =
  | { state: "in-sync"; expectedSerial: null; perPeer: Map<string, number | null> }
  | { state: "converging"; expectedSerial: number; perPeer: Map<string, number | null> }
  | { state: "diverged"; expectedSerial: null; perPeer: Map<string, number | null> };

/**
 * Given an expected serial + each peer's currently-observed serial, decide
 * the cluster's sync state. Pure — exported for unit tests.
 *
 *   - expectedSerial = null:
 *       all peers' serials are equal → in-sync
 *       any disagreement → diverged
 *   - expectedSerial = n:
 *       every peer's serial >= n → in-sync (and the caller should drop
 *         the cache entry)
 *       at least one peer < n → converging
 *       a peer's serial is null (unreachable) → still converging
 */
export function evaluateClusterSync(
  expectedSerial: number | null,
  perPeer: Map<string, number | null>,
): ClusterSyncVerdict {
  if (expectedSerial !== null) {
    let allMet = true;
    for (const v of perPeer.values()) {
      if (v === null || v < expectedSerial) {
        allMet = false;
        break;
      }
    }
    return allMet
      ? { state: "in-sync", expectedSerial: null, perPeer }
      : { state: "converging", expectedSerial, perPeer };
  }

  // No expected — compare peers against each other.
  let baseline: number | null = null;
  let mismatch = false;
  for (const v of perPeer.values()) {
    if (v === null) {
      // Unreachable peer with no expected serial → treat as diverged so
      // the chip reflects the gap.
      mismatch = true;
      break;
    }
    if (baseline === null) baseline = v;
    else if (v !== baseline) {
      mismatch = true;
      break;
    }
  }
  return mismatch
    ? { state: "diverged", expectedSerial: null, perPeer }
    : { state: "in-sync", expectedSerial: null, perPeer };
}
