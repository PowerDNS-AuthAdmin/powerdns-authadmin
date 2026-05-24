import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listUngroupedServers } from "@/lib/db/repositories/pdns-servers";
import { summarizeCapabilities } from "@/lib/pdns/capabilities";
import { ClusterForm, type AssignableServer } from "../_components/cluster-form";

export const metadata: Metadata = { title: "New group" };

export default async function NewClusterPage() {
  await requireUserForPage({ can: "server.create" });

  const ungrouped = await listUngroupedServers();
  const assignableServers: AssignableServer[] = ungrouped.map((s) => ({
    id: s.id,
    name: s.name,
    slug: s.slug,
    role: summarizeCapabilities(s.capabilities),
  }));

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
        <h1 className="text-2xl font-semibold tracking-tight">New group</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          A group relates backends that replicate together — the writable peers of a multi-primary
          cluster, or a primary with its read-only secondaries. Pick its initial members below, or
          assign them later from each server&rsquo;s page (or the provisioning YAML&rsquo;s{" "}
          <code>cluster_slug</code> field).
        </p>
      </header>
      <ClusterForm mode="create" assignableServers={assignableServers} />
    </div>
  );
}
