/**
 * lib/db/repositories/selectable-backends.ts
 *
 * "Logical backend" view used by every UI that presents a write target:
 * the zones list (fetches the union across backends), the create-zone
 * form (the operator-facing picker), and downstream routes that need to
 * route a request to either a specific server OR any peer in a cluster.
 *
 * The shape collapses the three deployment topologies into a single list:
 *
 *   • Standalone primary  → { kind: "server", server }
 *   • Primary + Secondaries → { kind: "server", server } (the primary)
 *                              Secondaries don't appear - they're read
 *                              mirrors of the primary's zone set.
 *   • Multi-primary cluster → { kind: "cluster", cluster, peers }
 *                              The cluster is ONE entry; individual peers
 *                              are not selectable on their own.
 *
 * Each entry carries a single `representativeServer` - a stable
 * identity (alphabetical first) used for things that need to be
 * consistent across requests, like audit-log lookups keyed on a
 * server slug. The actual peer to TALK to (read OR write) is picked
 * by `choosePeer(cluster, peers)` at call time so the cluster's
 * peer-selection strategy is honored uniformly across operations.
 */

import "server-only";
import { isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { pdnsClusters, pdnsServers, type PdnsCluster, type PdnsServer } from "@/lib/db/schema";
import { isReadOnlyMirror, isWriteCapable } from "@/lib/pdns/capabilities";

export type SelectableBackend =
  | {
      kind: "server";
      server: PdnsServer;
      representativeServer: PdnsServer;
      /**
       * Active secondaries mirroring this primary. Empty for standalone
       * primaries. Surfaced so UIs that present the primary as a write
       * target can still show its replication topology (the create-zone
       * form lists them as children under the primary, for example).
       */
      secondaries: PdnsServer[];
    }
  | {
      kind: "cluster";
      cluster: PdnsCluster;
      /** Writable members of the group (primaries). Never includes secondaries. */
      peers: PdnsServer[];
      representativeServer: PdnsServer;
      /** Read-only secondary members of the same group. */
      secondaries: PdnsServer[];
    };

/**
 * Build the deduplicated list of logical backends operators can target.
 * Disabled rows are excluded. Clusters with zero active peers fall out
 * of the list (operator-equivalent to "no backend").
 */
export async function listSelectableBackends(): Promise<SelectableBackend[]> {
  const [clusters, allServers] = await Promise.all([
    db.select().from(pdnsClusters).orderBy(pdnsClusters.name),
    db.select().from(pdnsServers).where(isNull(pdnsServers.disabledAt)).orderBy(pdnsServers.name),
  ]);

  const out: SelectableBackend[] = [];
  const seenClusters = new Set<string>();

  // Each group collapses to ONE entry. Peers are its WRITABLE members
  // (primaries) - never secondaries, so a write is never routed to a mirror.
  // Secondary members ride along for topology display.
  for (const c of clusters) {
    const members = allServers.filter((s) => s.clusterId === c.id);
    const peers = members.filter((s) => isWriteCapable(s.capabilities));
    if (peers.length === 0) continue;
    seenClusters.add(c.id);
    out.push({
      kind: "cluster",
      cluster: c,
      peers,
      representativeServer: peers[0]!,
      secondaries: members.filter((s) => isReadOnlyMirror(s.capabilities)),
    });
  }

  // Standalone write targets (not in a group). A backend's managed secondaries
  // are group members, so a write target outside any group has none here.
  for (const s of allServers) {
    if (!isWriteCapable(s.capabilities)) continue;
    if (s.clusterId && seenClusters.has(s.clusterId)) continue;
    out.push({
      kind: "server",
      server: s,
      representativeServer: s,
      secondaries: [],
    });
  }

  return out;
}
