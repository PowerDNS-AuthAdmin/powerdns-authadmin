/**
 * lib/pdns/cluster-picker-pure.ts
 *
 * Pure helpers for the cluster write-strategy picker. Kept separate from
 * `cluster-picker.ts` so unit tests can exercise the deterministic logic
 * without pulling lib/db (which loads pg at module init under vitest).
 *
 * Shape: take a `cluster` row + the list of candidate peers, return the
 * peer to write to. Strategies that need DB samples (lowest_latency,
 * least_load) take a pre-fetched samples map; the wrapper in
 * `cluster-picker.ts` reads from `pdns_server_stats` and calls into here.
 */

type WriteStrategy = "round_robin" | "lowest_latency" | "random" | "least_load";

export interface PickablePeer {
  id: string;
  slug: string;
}

export interface PeerSamples {
  /** Recent observed p50 latency per peer id (ms). Missing peers default
   *  to +Infinity so they sort to the bottom — a peer we have no data
   *  for is less attractive than one we've measured.  */
  latencyP50Ms: Map<string, number>;
  /** Recent zone counts per peer id (proxy for "load"). Missing → 0. */
  zoneCounts: Map<string, number>;
}

/**
 * Process-local round-robin index per cluster id. Resets on app boot —
 * a stricter cross-instance fairness guarantee would need DB state, which
 * isn't worth the write per request for an internal hint. The map only
 * grows by O(clusters); never trimmed.
 */
const rrIndex = new Map<string, number>();

/** Test-only reset. */
export function _resetRoundRobinIndex(): void {
  rrIndex.clear();
}

export function pickPeer(
  cluster: { id: string; writeStrategy: WriteStrategy },
  peers: readonly PickablePeer[],
  samples?: PeerSamples,
): PickablePeer | null {
  if (peers.length === 0) return null;
  if (peers.length === 1) return peers[0]!;

  switch (cluster.writeStrategy) {
    case "round_robin": {
      const i = rrIndex.get(cluster.id) ?? 0;
      const choice = peers[i % peers.length]!;
      rrIndex.set(cluster.id, i + 1);
      return choice;
    }
    case "random": {
      const i = Math.floor(Math.random() * peers.length);
      return peers[i]!;
    }
    case "lowest_latency": {
      if (!samples) return peers[0]!;
      let best = peers[0]!;
      let bestMs = samples.latencyP50Ms.get(best.id) ?? Number.POSITIVE_INFINITY;
      for (let i = 1; i < peers.length; i += 1) {
        const p = peers[i]!;
        const ms = samples.latencyP50Ms.get(p.id) ?? Number.POSITIVE_INFINITY;
        if (ms < bestMs) {
          best = p;
          bestMs = ms;
        }
      }
      return best;
    }
    case "least_load": {
      if (!samples) {
        // No samples → random rather than always-first; otherwise the
        // first peer would always win and degenerate to the wrong shape.
        const i = Math.floor(Math.random() * peers.length);
        return peers[i]!;
      }
      let best = peers[0]!;
      let bestCount = samples.zoneCounts.get(best.id) ?? 0;
      for (let i = 1; i < peers.length; i += 1) {
        const p = peers[i]!;
        const c = samples.zoneCounts.get(p.id) ?? 0;
        if (c < bestCount) {
          best = p;
          bestCount = c;
        }
      }
      return best;
    }
    default: {
      // Exhaustiveness check — every literal of WriteStrategy is handled.
      const _exhaustive: never = cluster.writeStrategy;
      void _exhaustive;
      return peers[0]!;
    }
  }
}
