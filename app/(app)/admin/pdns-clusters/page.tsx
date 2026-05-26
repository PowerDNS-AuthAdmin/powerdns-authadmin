/**
 * app/(app)/admin/pdns-clusters/page.tsx
 *
 * Lists multi-primary PDNS clusters with their peer-selection strategy
 * and peer count. Permission: `server.read`. Create / edit / delete
 * gated on `server.create` / `server.update` / `server.delete`.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllClusters } from "@/lib/db/repositories/pdns-clusters";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { classifyGroup } from "@/lib/pdns/capabilities";
import type { PdnsServer } from "@/lib/db/schema";
import { CreateButton } from "@/components/ui/create-button";
import { GroupsTable, type GroupRow } from "./_components/groups-table";

export const metadata: Metadata = { title: "Groups" };

export default async function PdnsClustersListPage() {
  const { ability } = await requireUserForPage({ can: "server.read" });
  const canCreate = ability.can("create", "Server");

  const [clusters, allServers] = await Promise.all([listAllClusters(), listAllPdnsServers()]);
  const membersByCluster = new Map<string, PdnsServer[]>();
  for (const s of allServers) {
    if (!s.clusterId) continue;
    const arr = membersByCluster.get(s.clusterId) ?? [];
    arr.push(s);
    membersByCluster.set(s.clusterId, arr);
  }

  const rows: GroupRow[] = clusters.map((c) => {
    const members = membersByCluster.get(c.id) ?? [];
    const composition = classifyGroup(members);
    return {
      id: c.id,
      name: c.name,
      slug: c.slug,
      typeLabel: composition.typeLabel,
      isMultiPrimary: composition.isMultiPrimary,
      writeStrategy: c.writeStrategy,
      memberCount: members.length,
    };
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Related backends polled + compared together — a multi-primary cluster (writable peers
            sharing storage) or a primary with its read-only secondaries. The peer-selection
            strategy applies only to multi-primary clusters.
          </p>
        </div>
        {canCreate ? <CreateButton href="/admin/pdns-clusters/new" label="Add group" /> : null}
      </header>

      {clusters.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-sm text-[color:var(--color-fg-muted)]">
          No groups defined yet. A group relates backends that replicate together — the writable
          peers of a multi-primary cluster, or a primary with its read-only secondaries. Standalone
          backends don&rsquo;t need a group.
        </div>
      ) : (
        <GroupsTable rows={rows} />
      )}
    </div>
  );
}
