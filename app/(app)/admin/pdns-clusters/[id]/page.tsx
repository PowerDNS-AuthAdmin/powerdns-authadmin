import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { findClusterById, listAllServersForCluster } from "@/lib/db/repositories/pdns-clusters";
import { classifyGroup } from "@/lib/pdns/capabilities";
import { ClusterForm } from "../_components/cluster-form";
import { DeleteClusterButton } from "./_components/delete-cluster-button";

export const metadata: Metadata = { title: "Group" };

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ClusterDetailPage({ params }: PageProps) {
  const { ability } = await requireUserForPage({ can: "server.read" });
  const { id } = await params;
  const cluster = await findClusterById(id);
  if (!cluster) notFound();

  const canEdit = ability.can("update", "Server");
  const canDelete = ability.can("delete", "Server");

  const members = await listAllServersForCluster(id);
  const composition = classifyGroup(members);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/admin/pdns-clusters"
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          ← Back to groups
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{cluster.name}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[color:var(--color-fg-muted)]">
          <code className="font-mono">{cluster.slug}</code>
          <span className="rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] px-1.5 py-0.5 text-[0.625rem] tracking-wide uppercase">
            {composition.typeLabel}
          </span>
          {composition.isMultiPrimary ? (
            <span className="rounded bg-[color:var(--color-accent)]/15 px-1.5 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-accent)] uppercase">
              {cluster.writeStrategy.replace("_", " ")}
            </span>
          ) : null}
        </p>
      </header>

      {canEdit ? (
        <section>
          <h2 className="mb-3 text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
            Settings
          </h2>
          <ClusterForm
            mode="edit"
            showStrategy={composition.isMultiPrimary}
            clusterId={cluster.id}
            initialSlug={cluster.slug}
            initialName={cluster.name}
            initialDescription={cluster.description ?? ""}
            initialWriteStrategy={cluster.writeStrategy}
          />
        </section>
      ) : null}

      <section className="space-y-2">
        <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Members ({members.length})
        </h2>
        {members.length === 0 ? (
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            No PDNS servers reference this cluster yet. Edit a server&rsquo;s row at{" "}
            <Link
              href="/admin/servers"
              className="text-[color:var(--color-accent)] hover:underline"
            >
              /admin/servers
            </Link>{" "}
            to assign it.
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-border)] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)]">
            {members.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2">
                <Link
                  href={`/admin/servers/${m.id}`}
                  className="text-sm font-medium hover:text-[color:var(--color-accent)] hover:underline"
                >
                  {m.name}
                </Link>
                <span className="font-mono text-xs text-[color:var(--color-fg-muted)]">
                  {m.slug}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canDelete ? (
        <section className="border-t border-[color:var(--color-border)] pt-6">
          <h2 className="text-sm font-medium tracking-wide text-[color:var(--color-error)] uppercase">
            Danger zone
          </h2>
          <div className="mt-3 flex items-start justify-between gap-4 rounded-md border border-[color:var(--color-error)]/40 bg-[color:var(--color-error)]/5 p-4">
            <p className="flex-1 text-sm text-[color:var(--color-fg-muted)]">
              Delete this group. Members are detached from the group and revert to standalone
              semantics; the server rows themselves stay.
            </p>
            <DeleteClusterButton
              clusterId={cluster.id}
              clusterName={cluster.name}
              memberCount={members.length}
            />
          </div>
        </section>
      ) : null}
    </div>
  );
}
