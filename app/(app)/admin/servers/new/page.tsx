/**
 * app/(app)/admin/servers/new/page.tsx
 *
 * "Add PowerDNS server" form. Server component shell with a client form for
 * input + immediate validation feedback. Permission-gated by `server.create`.
 *
 * Accepts an optional `?secondaryOf=<primaryId>` so the primary's edit page
 * can deep-link to a pre-selected "add secondary" flow.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listAllPrimaries } from "@/lib/db/repositories/pdns-servers";
import { ServerForm } from "../_components/server-form";

export const metadata: Metadata = { title: "Add PowerDNS server" };

interface PageProps {
  searchParams: Promise<{ secondaryOf?: string }>;
}

export default async function NewPdnsServerPage({ searchParams }: PageProps) {
  await requireUserForPage({ can: "server.create" });
  const { secondaryOf } = await searchParams;

  const primaries = (await listAllPrimaries()).map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
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

      <ServerForm
        mode="create"
        primaries={primaries}
        {...(secondaryOf ? { forSecondaryOf: secondaryOf } : {})}
      />
    </div>
  );
}
