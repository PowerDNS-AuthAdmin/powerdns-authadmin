/**
 * app/(app)/admin/import-export/page.tsx
 *
 * Zone import/export hub. Three flows, one page:
 *
 *   1. Import - paste a single zone or a multi-zone BIND file. The
 *      parser auto-splits zones at `$ORIGIN` boundaries; each becomes
 *      one createZone call with its rrsets pre-populated.
 *   2. Export - pick zones from a backend, download them as a single
 *      BIND-format text bundle.
 *
 * Permission: `zone.read` to load, plus `zone.create` enforced on the
 * import API for the actual create.
 */

import type { Metadata } from "next";
import { requireUserForPage } from "@/lib/auth/require-user";
import { listActivePdnsServers } from "@/lib/db/repositories/pdns-servers";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { listEligibleTsigKeys } from "@/lib/realtime/tsig-eligibility";
import { listPrimarySecondaries } from "@/lib/realtime/tsig-replication";
import { ImportExportClient } from "./_components/import-export-client";

export const metadata: Metadata = { title: "Import / Export" };

export default async function ImportExportPage() {
  const { ability, globalPermissions } = await requireUserForPage({ can: "zone.read" });
  const canImport = ability.can("create", "Zone");
  const canReadTsig = globalPermissions.has("tsig.read");
  const servers = await listActivePdnsServers();

  if (canImport && canReadTsig) {
    await ensureBackendsObserved();
  }

  const tsigKeysByServer = new Map<string, Array<{ name: string; zoneCount: number }>>();
  if (canImport && canReadTsig) {
    const entries = await Promise.all(
      servers.map(async (server) => {
        const secondaries = await listPrimarySecondaries(server);
        const eligible = await listEligibleTsigKeys({
          keyHosts: [server, ...secondaries],
          zoneHosts: [server],
        });
        return [
          server.slug,
          eligible.map((key) => ({ name: key.name, zoneCount: key.zoneCount })),
        ] as const;
      }),
    );
    for (const [serverSlug, keys] of entries) tsigKeysByServer.set(serverSlug, keys);
  }

  const backends = servers.map((s) => ({
    slug: s.slug,
    label: s.name,
    tsigKeys: tsigKeysByServer.get(s.slug) ?? [],
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Import / Export</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Bring zones in from a BIND zonefile, or download one or many zones as a single text
          bundle.
        </p>
      </header>
      <ImportExportClient backends={backends} canImport={canImport} />
    </div>
  );
}
