/**
 * app/(app)/zones/new/page.tsx
 *
 * Create-zone landing. Permission: `zone.create`. Pulls the available
 * backends and templates server-side and hands them to the client form.
 * Most logic (validation, kind-conditional fields) lives in the form
 * component below - this page only orchestrates.
 */

import { requireUserForPage } from "@/lib/auth/require-user";
import { listSelectableBackends } from "@/lib/db/repositories/selectable-backends";
import { listAllZoneTemplates } from "@/lib/db/repositories/zone-templates";
import { CreateZoneForm, type BackendOption } from "../_components/create-zone-form";

export const metadata = { title: "Create zone" };

export default async function NewZonePage({
  searchParams,
}: {
  searchParams: Promise<{ server?: string; cluster?: string; template?: string }>;
}) {
  await requireUserForPage({ can: "zone.create" });
  const {
    server: requestedServerSlug,
    cluster: requestedClusterSlug,
    template: requestedTemplate,
  } = await searchParams;

  const [backends, templates] = await Promise.all([
    listSelectableBackends(),
    listAllZoneTemplates(),
  ]);

  // Collapse SelectableBackend[] into the form's option shape. A cluster
  // is ONE option (not its peers) - the write_strategy picks the peer at
  // submit time on the server. Every entry carries the writable primary
  // ids it creates zones through (the standalone primary's own id, or each
  // cluster peer's id) so the form can match against template
  // `defaultForPrimaryIds`; standalone entries also carry their active
  // secondaries so the BACKEND section can render them as children.
  const backendOptions: BackendOption[] = backends.map((b) =>
    b.kind === "cluster"
      ? {
          kind: "cluster",
          slug: b.cluster.slug,
          name: `${b.cluster.name} · ${b.peers.length}-peer cluster`,
          isDefault: false,
          primaryIds: b.peers.map((peer) => peer.id),
          secondaries: [],
        }
      : {
          kind: "server",
          slug: b.server.slug,
          name: b.server.name,
          isDefault: b.server.isDefault,
          primaryIds: [b.server.id],
          secondaries: b.secondaries.map((s) => ({ slug: s.slug, name: s.name })),
        },
  );

  // Translate ?server=<slug> | ?cluster=<slug> into the form's initial
  // selection - used by "Create zone" links coming off the zone list.
  let initialSelection: { kind: "server" | "cluster"; slug: string } | undefined;
  if (requestedClusterSlug) {
    initialSelection = { kind: "cluster", slug: requestedClusterSlug };
  } else if (requestedServerSlug) {
    initialSelection = { kind: "server", slug: requestedServerSlug };
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Add zone</h1>
        <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
          Add a new zone to a PowerDNS backend. Pick a template to start with a known-good NS set +
          SOA timers, or fill them in by hand.
        </p>
      </header>

      <CreateZoneForm
        backends={backendOptions}
        templates={templates.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          nameservers: t.nameservers,
          recordCount: t.records.length,
          soaRefresh: t.soaRefresh,
          soaRetry: t.soaRetry,
          soaExpire: t.soaExpire,
          soaMinimum: t.soaMinimum,
          kind: t.kind,
          soaEdit: t.soaEdit,
          soaEditApi: t.soaEditApi,
          apiRectify: t.apiRectify,
          metadataKinds: Object.keys(t.metadata ?? {}).sort(),
          defaultForPrimaryIds: t.defaultForPrimaryIds ?? [],
        }))}
        initialSelection={initialSelection}
        initialTemplateId={requestedTemplate}
      />
    </div>
  );
}
