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
import { classifyGroup } from "@/lib/pdns/capabilities";
import type { PdnsServer } from "@/lib/db/schema";

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

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Groups</h1>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            Related backends polled + compared together — a multi-primary cluster (writable peers
            sharing storage) or a primary with its read-only secondaries. The peer-selection
            strategy applies only to multi-primary clusters.
          </p>
        </div>
        {canCreate ? (
          <Link
            href="/admin/pdns-clusters/new"
            className="shrink-0 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
          >
            New group
          </Link>
        ) : null}
      </header>

      {clusters.length === 0 ? (
        <div className="rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-6 text-sm text-[color:var(--color-fg-muted)]">
          No groups defined yet. A group relates backends that replicate together — the writable
          peers of a multi-primary cluster, or a primary with its read-only secondaries. Standalone
          backends don&rsquo;t need a group.
        </div>
      ) : (
        <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
          {clusters.map((c) => {
            const members = membersByCluster.get(c.id) ?? [];
            const composition = classifyGroup(members);
            return (
              <li key={c.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/admin/pdns-clusters/${c.id}`}
                    className="block font-medium hover:text-[color:var(--color-accent)] hover:underline"
                  >
                    {c.name}
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-[color:var(--color-fg-muted)]">
                    <code className="font-mono">{c.slug}</code>
                    <span className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-1.5 py-0.5 text-[0.625rem] tracking-wide uppercase">
                      {composition.typeLabel}
                    </span>
                    {composition.isMultiPrimary ? (
                      <span className="rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-accent)] uppercase">
                        {c.writeStrategy.replace("_", " ")}
                      </span>
                    ) : null}
                    <span>
                      {members.length} member{members.length === 1 ? "" : "s"}
                    </span>
                  </div>
                  {c.description ? (
                    <p className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
                      {c.description}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
