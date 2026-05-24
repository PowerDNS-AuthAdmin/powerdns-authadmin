/**
 * app/(app)/admin/servers/new/page.tsx
 *
 * "Add PowerDNS server" form. Server component shell with a client form for
 * input + immediate validation feedback. Permission-gated by `server.create`.
 *
 * Accepts an optional `?group=<clusterId>` so a primary's edit page can
 * deep-link to a pre-selected "add secondary to this group" flow.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllClusters } from "@/lib/db/repositories/pdns-clusters";
import { ServerForm } from "../_components/server-form";

export const metadata: Metadata = { title: "Add PowerDNS server" };

interface PageProps {
  searchParams: Promise<{ group?: string }>;
}

export default async function NewPdnsServerPage({ searchParams }: PageProps) {
  await requireUserForPage({ can: "server.create" });
  const { group } = await searchParams;

  const groups = (await listAllClusters()).map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
  }));

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add PowerDNS server</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Connect to a PowerDNS Authoritative HTTP API. The API key is encrypted at rest and never
          returned by the UI again.
        </p>
      </header>

      <ServerForm mode="create" groups={groups} {...(group ? { forGroup: group } : {})} />
    </div>
  );
}
