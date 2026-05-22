import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPage } from "@/lib/auth/require-user";
import { ClusterForm } from "../_components/cluster-form";

export const metadata: Metadata = { title: "New cluster" };

export default async function NewClusterPage() {
  await requireUserForPage({ can: "server.create" });
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/admin/pdns-clusters"
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          ← Back to clusters
        </Link>
      </div>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">New cluster</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          A cluster groups multiple writable PDNS peers. Assign peers to it from each server&rsquo;s
          edit page (or via the provisioning YAML&rsquo;s <code>cluster_slug</code> field).
        </p>
      </header>
      <ClusterForm mode="create" />
    </div>
  );
}
