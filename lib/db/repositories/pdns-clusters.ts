/**
 * lib/db/repositories/pdns-clusters.ts
 *
 * CRUD over `pdns_clusters` + a join helper to list every peer in a
 * cluster. Pure data access — auth + audit are caller concerns.
 */

import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db, type DbExecutor } from "@/lib/db";
import {
  pdnsClusters,
  pdnsServers,
  type NewPdnsCluster,
  type PdnsCluster,
  type PdnsServer,
} from "@/lib/db/schema";

export async function listAllClusters(): Promise<PdnsCluster[]> {
  return db.select().from(pdnsClusters).orderBy(pdnsClusters.name);
}

export async function findClusterById(id: string): Promise<PdnsCluster | null> {
  const rows = await db.select().from(pdnsClusters).where(eq(pdnsClusters.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findClusterBySlug(slug: string): Promise<PdnsCluster | null> {
  const rows = await db.select().from(pdnsClusters).where(eq(pdnsClusters.slug, slug)).limit(1);
  return rows[0] ?? null;
}

export async function insertCluster(
  input: NewPdnsCluster,
  executor: DbExecutor = db,
): Promise<PdnsCluster> {
  const rows = await executor.insert(pdnsClusters).values(input).returning();
  if (!rows[0]) throw new Error("Cluster insert returned no row.");
  return rows[0];
}

export async function updateCluster(
  id: string,
  patch: Partial<Omit<PdnsCluster, "id" | "createdAt">>,
  executor: DbExecutor = db,
): Promise<PdnsCluster | null> {
  const rows = await executor
    .update(pdnsClusters)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(pdnsClusters.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deleteCluster(id: string, executor: DbExecutor = db): Promise<void> {
  await executor.delete(pdnsClusters).where(eq(pdnsClusters.id, id));
}

/**
 * Every active peer in a cluster (i.e. servers with cluster_id set and
 * disabledAt NULL). Used by the write-strategy picker and the sync probe.
 */
export async function listActivePeersForCluster(clusterId: string): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(and(eq(pdnsServers.clusterId, clusterId), isNull(pdnsServers.disabledAt)))
    .orderBy(pdnsServers.name);
}

/**
 * All servers in a cluster, including disabled ones. Used by the admin
 * UI's cluster detail page so the operator can re-enable.
 */
export async function listAllServersForCluster(clusterId: string): Promise<PdnsServer[]> {
  return db
    .select()
    .from(pdnsServers)
    .where(eq(pdnsServers.clusterId, clusterId))
    .orderBy(pdnsServers.name);
}
