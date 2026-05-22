/**
 * app/(app)/admin/pdns-clusters/page.tsx
 *
 * Lists multi-primary PDNS clusters with their peer-selection strategy
 * and peer count. Permission: `server.read`. Create / edit / delete
 * gated on `server.create` / `server.update` / `server.delete`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllClusters } from "@/lib/db/repositories/pdns-clusters";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";

export const metadata: Metadata = { title: "PowerDNS clusters" };

export default async function PdnsClustersListPage() {
  const { ability } = await requireUserForPage({ can: "server.read" });
  const canCreate = ability.can("create", "Server");

  const [clusters, allServers] = await Promise.all([listAllClusters(), listAllPdnsServers()]);
  const memberCount = new Map<string, number>();
  for (const s of allServers) {
    if (s.clusterId) memberCount.set(s.clusterId, (memberCount.get(s.clusterId) ?? 0) + 1);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">PowerDNS clusters</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Multi-primary peer groups. Every member of a cluster is writable; the cluster&rsquo;s
            peer-selection strategy decides which peer the app routes reads + writes through.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/admin/pdns-clusters/new"
            className="shrink-0 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
          >
            New cluster
          </Link>
        ) : null}
      </header>

      {clusters.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-sm text-[color:var(--color-fg-muted)]">
          No clusters defined yet. A cluster groups N writable PDNS peers whose underlying storage
          replicates (Galera, Postgres logical replication, etc.). Standalone primaries and
          primary+secondary setups don&rsquo;t need a cluster.
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
          {clusters.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <Link
                  href={`/admin/pdns-clusters/${c.id}`}
                  className="block font-medium hover:text-[color:var(--color-accent)] hover:underline"
                >
                  {c.name}
                </Link>
                <div className="mt-0.5 flex items-center gap-3 text-xs text-[color:var(--color-fg-muted)]">
                  <code className="font-mono">{c.slug}</code>
                  <span className="rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-accent)] uppercase">
                    {c.writeStrategy.replace("_", " ")}
                  </span>
                  <span>
                    {memberCount.get(c.id) ?? 0} member
                    {(memberCount.get(c.id) ?? 0) === 1 ? "" : "s"}
                  </span>
                </div>
                {c.description ? (
                  <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">{c.description}</p>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
