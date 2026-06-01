/**
 * lib/pdns/cluster-picker.ts
 *
 * DB-touching wrapper around `pickPeer` from `cluster-picker-pure.ts`.
 * Reads recent latency + zone-count samples from `pdns_server_stats` /
 * `metric_samples` when the strategy needs them, then delegates.
 *
 * Callers: every cluster-aware operation that needs a single peer to
 * read FROM or write TO - zone create, RRset PATCH, the zone-detail
 * page, the zones-list amalgamator. The cluster's peer-selection
 * strategy ("Write strategy" in the DB; surfaced as "Peer selection
 * strategy" in the UI per T-112) governs the choice in both directions
 * - the operator's intent is "use one peer per the strategy," not
 * "writes go through the strategy but reads pick alphabetically."
 */

/* eslint-disable no-restricted-imports -- Sanctioned lib/pdns→lib/db bridge:
   the picker reads metric_samples to make a peer-routing decision. The pure
   decision lives in ./cluster-picker-pure; this file only loads its inputs.
   See ADR-0013. Future work: pass samples in and relocate above lib/pdns. */
import "server-only";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { metricSamples, type PdnsCluster, type PdnsServer } from "@/lib/db/schema";
import { pickPeer, type PeerSamples } from "./cluster-picker-pure";

export { pickPeer, type PickablePeer, type PeerSamples } from "./cluster-picker-pure";

/**
 * Pick which peer the next operation on `cluster` should target -
 * applies to BOTH reads and writes per the cluster's peer-selection
 * strategy. Caller has already filtered `peers` to the active members.
 * Returns null only when `peers` is empty.
 */
export async function choosePeer(
  cluster: PdnsCluster,
  peers: PdnsServer[],
): Promise<PdnsServer | null> {
  if (peers.length === 0) return null;
  if (peers.length === 1) return peers[0]!;

  // For the strategies that don't need samples, skip the DB read.
  if (cluster.writeStrategy === "round_robin" || cluster.writeStrategy === "random") {
    const choice = pickPeer({ id: cluster.id, writeStrategy: cluster.writeStrategy }, peers);
    return choice ? (peers.find((p) => p.id === choice.id) ?? null) : null;
  }

  const samples = await loadSamples(peers.map((p) => p.id));
  const choice = pickPeer({ id: cluster.id, writeStrategy: cluster.writeStrategy }, peers, samples);
  return choice ? (peers.find((p) => p.id === choice.id) ?? null) : null;
}

/**
 * Read the most-recent latency + zone-count sample per peer from
 * `metric_samples`. The dashboard sampler writes one row per backend
 * every ~5 minutes; the lookup is bounded by len(peers) rows.
 */
async function loadSamples(peerIds: string[]): Promise<PeerSamples> {
  const samples: PeerSamples = { latencyP50Ms: new Map(), zoneCounts: new Map() };
  if (peerIds.length === 0) return samples;

  // For each peer, take the latest metric_samples row.
  for (const id of peerIds) {
    const rows = await db
      .select({
        latencyP50Ms: metricSamples.latencyP50Ms,
        zoneCount: metricSamples.zoneCount,
      })
      .from(metricSamples)
      .where(eq(metricSamples.serverId, id))
      .orderBy(desc(metricSamples.sampledAt))
      .limit(1);
    const row = rows[0];
    if (!row) continue;
    if (row.latencyP50Ms !== null) samples.latencyP50Ms.set(id, row.latencyP50Ms);
    if (row.zoneCount !== null) samples.zoneCounts.set(id, row.zoneCount);
  }
  void inArray; // silence unused warning if drizzle re-exports change
  return samples;
}
