/**
 * app/(app)/zones/[zoneId]/page.tsx
 *
 * Read-only zone detail. RSC; fetches the zone (incl. rrsets) via the cached
 * PdnsClient. Supports `?server=` to scope to a non-default backend, matching
 * the list page's convention. Editing lands later
 *
 * Permission: `zone.read`.
 */

import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import { hasZonePermissionViaGrant } from "@/lib/rbac/zone-permissions";
import {
  findDefaultPdnsServer,
  findPdnsServerById,
  findPdnsServerBySlug,
} from "@/lib/db/repositories/pdns-servers";
import {
  findClusterById,
  findClusterBySlug,
  listActivePeersForCluster,
} from "@/lib/db/repositories/pdns-clusters";
import { choosePeer } from "@/lib/pdns/cluster-picker";
import type { PdnsCluster, PdnsServer } from "@/lib/db/schema";
import { latestZoneEdit, zoneAuditLog } from "@/lib/db/repositories/audit-log";
import { findPdnsRequestsByRequestIds } from "@/lib/db/repositories/pdns-requests";
import { listAllPdnsServers } from "@/lib/db/repositories/pdns-servers";
import { normalizeZoneId } from "@/lib/pdns/client";
import { zoneCapabilities } from "@/lib/pdns/writable-kind";
import { normalizeMaster } from "@/lib/pdns/topology";
import { derivedUpstreamFor } from "@/lib/pdns/topology-cache";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
import { logger } from "@/lib/logger";
import { pdnsBackgroundPollingEnabled } from "@/lib/env";
import { redact } from "@/lib/errors/redact";
import { parseSoaContent, type SoaFields } from "@/lib/validators/soa";
import { Lock } from "lucide-react";
import { RecordTable } from "@/components/domain/record-table";
import { EditableRecordTable } from "./_components/editable-record-table";
import { SoaPanel } from "./_components/soa-panel";
import { ZoneSettingsPanel } from "./_components/zone-settings-panel";
import { ZoneDangerZone } from "./_components/zone-danger-zone";
import { DnssecSection } from "./_components/dnssec-section";
import { MetadataSection } from "./_components/metadata-section";
import { ZoneStatisticsSection } from "./_components/statistics-section";
import { SyncSection } from "./_components/sync-section";
import { checkZoneSync } from "@/lib/pdns/sync";
import { TabBodySkeleton } from "./_components/tab-body-skeleton";
import { AccessSection } from "./_components/access-section";
import { ZoneChangeLog, type ZoneAuditEntryClient } from "./_components/zone-change-log";
import type { PdnsHttpLogEntry } from "./_components/pdns-http-log";
import { ZoneHeader } from "./_components/zone-header";
import { ZoneTabs } from "./_components/zone-tabs";
import { ScrollToTab } from "./_components/scroll-to-tab";
import { redactSnapshot } from "@/lib/audit/log";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

interface PageProps {
  params: Promise<{ zoneId: string }>;
  searchParams: Promise<{ server?: string; cluster?: string; tab?: string }>;
}

type ZoneTab =
  | "records"
  | "soa"
  | "settings"
  | "dnssec"
  | "metadata"
  | "sync"
  | "statistics"
  | "access"
  | "history";

// Always re-render on navigation - the zone state on the upstream PDNS
// can change between tab switches (other operators editing, a NOTIFY
// triggering a serial bump, etc). Combined with `experimental.staleTimes`
// in next.config, this keeps the Records tab honest.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = { title: "Zone" };

export default async function ZoneDetailPage({ params, searchParams }: PageProps) {
  // Authenticate only - the zone.read gate is per-zone (global permission
  // OR a zone_grant for THIS server+zone) and is applied below once the
  // backend + canonical zone name are resolved.
  const { globalPermissions, zoneGrants } = await requireUserForPage();
  const { zoneId } = await params;
  const {
    server: requestedSlug,
    cluster: requestedClusterSlug,
    tab: requestedTab,
  } = await searchParams;

  // Two entry points land in cluster mode:
  //   (a) ?cluster=<slug>            - explicit (canonical URL form)
  //   (b) ?server=<peer slug>        - implicit, when the selected
  //                                    server's clusterId is non-null
  // In both cases the cluster's peer-selection strategy picks which
  // peer we actually read from for this render - round_robin spreads
  // requests across peers, lowest_latency pins to the fastest one,
  // etc. The operator's choice of URL form is just a shortcut; the
  // peer is fungible from their POV ("the cluster's writable surface
  // is the cluster, not peer-2").
  let selected: PdnsServer;
  let clusterContext: {
    id: string;
    name: string;
    slug: string;
    peers: PdnsServer[];
  } | null = null;
  let resolvedCluster: PdnsCluster | null = null;
  let resolvedPeers: PdnsServer[] = [];

  if (requestedClusterSlug) {
    const cluster = await findClusterBySlug(requestedClusterSlug);
    if (!cluster) {
      return (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>Unknown cluster.</strong>{" "}
          <Link href="/zones" className="underline">
            Back to zones
          </Link>
          .
        </div>
      );
    }
    const peers = await listActivePeersForCluster(cluster.id);
    if (peers.length === 0) {
      return (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>Cluster has no active peers.</strong>{" "}
          <Link href="/zones" className="underline">
            Back to zones
          </Link>
          .
        </div>
      );
    }
    resolvedCluster = cluster;
    resolvedPeers = peers;
  } else {
    const explicit = requestedSlug
      ? await findPdnsServerBySlug(requestedSlug)
      : await findDefaultPdnsServer();
    if (explicit?.disabledAt !== null) {
      return (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-6 text-sm">
          <strong>No backend selected.</strong>{" "}
          <Link href="/zones" className="underline">
            Pick a server
          </Link>{" "}
          to load this zone.
        </div>
      );
    }
    if (explicit.clusterId) {
      const cluster = await findClusterById(explicit.clusterId);
      if (cluster) {
        // Canonicalize: `?server=<peer>` URLs land in cluster mode
        // because the peer isn't operator-facing for cluster zones -
        // the cluster is. Redirect so refreshes, bookmarks, and
        // sharing all reflect the cluster as the addressable thing.
        const tabSegment = requestedTab ? `&tab=${encodeURIComponent(requestedTab)}` : "";
        redirect(
          `/zones/${encodeURIComponent(zoneId)}?cluster=${encodeURIComponent(cluster.slug)}${tabSegment}`,
        );
      }
    }
    selected = explicit;
  }

  if (resolvedCluster) {
    // Peer-selection strategy decides which peer to read from. Falls
    // back to the first active peer only if `choosePeer` somehow
    // returns null (shouldn't with the length check above).
    const chosen = await choosePeer(resolvedCluster, resolvedPeers);
    selected = chosen ?? resolvedPeers[0]!;
    clusterContext = {
      id: resolvedCluster.id,
      name: resolvedCluster.name,
      slug: resolvedCluster.slug,
      peers: resolvedPeers,
    };
  } else {
    // narrowed above
    selected = selected!;
  }

  const decoded = decodeURIComponent(zoneId);
  const canonical = normalizeZoneId(decoded);

  // Audit/history is scoped by backend slug. For a cluster, writes route
  // through a rotating peer (choosePeer), so a zone's edits are scattered
  // across every peer's slug - aggregate them all (ADR-0014). Otherwise just
  // the selected backend.
  const auditSlugs = clusterContext ? clusterContext.peers.map((p) => p.slug) : [selected.slug];

  // Per-zone authorization: a permission is held if it's granted at GLOBAL
  // scope OR a zone_grant covers THIS (server, zone). We deliberately avoid a
  // type-level `ability.can(action, "Type")` - it returns true for a
  // team/zone-scoped rule and would expose every zone. See
  // `lib/rbac/ability.ts:globalPermissionsOf`.
  const zoneCan = (perm: string): boolean =>
    globalPermissions.has(perm) ||
    hasZonePermissionViaGrant(zoneGrants, selected.id, canonical, perm);
  if (!zoneCan("zone.read")) {
    redirect("/zones?flash=forbidden&need=zone.read");
  }

  // getZone first so we know the primary's serial - the sync probe
  // needs it to compute the verdict (passing `null` made every
  // secondary come back as state="error" → chip stuck on "syncing").
  // audit + sync still run in parallel below.
  const client = getBackendGateway(selected);
  let zone: PdnsZoneDetail | null = null;
  let fetchError: string | null = null;
  try {
    zone = await client.getZone(canonical);
  } catch (err) {
    if (err instanceof PdnsNotFoundError) {
      notFound();
    }
    fetchError = err instanceof Error ? redact(err.message) : "Unknown error";
    logger.warn(
      { server: selected.slug, zone: canonical, error: fetchError },
      "zone.detail.failed",
    );
  }

  // Back link returns to the amalgamated zones list - no per-backend
  // filter to preserve since the list shows every backend at once.
  const backLink = "/zones";

  if (fetchError || !zone) {
    return (
      <div className="space-y-4">
        <Link href={backLink} className="text-sm text-[color:var(--color-accent)] hover:underline">
          ← Back to zones
        </Link>
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error)]">
          <strong>Could not load zone.</strong> {fetchError ?? "Empty response from PowerDNS."}
        </div>
      </div>
    );
  }

  const rrsets = zone.rrsets ?? [];
  const nonSoaRrsets = rrsets.filter((rr) => rr.type !== "SOA");
  const soaRrset = rrsets.find((rr) => rr.type === "SOA");
  const soaFields = parseSoaSafely(soaRrset?.records[0]?.content ?? null);
  const soaTtl = soaRrset?.ttl ?? 3600;

  // Read-only-by-KIND: a Slave/Secondary/Consumer zone's records + DNSSEC are
  // owned by its primary over AXFR, so they're read-only regardless of the
  // backend's role - a "primary" box can host mirror zones, and vice-versa.
  // Mirrors the server-side guard (lib/pdns/writable-kind.ts). Replication
  // config (masters via settings, transfer metadata) + removing the mirror
  // (zone.delete) stay available.
  const ops = zoneCapabilities(zone.kind);
  const isReadOnlyZone = !ops.rrsets;
  // For a mirror zone, its upstream is read from the site-wide derived topology
  // (poller-computed from masters[], ADR-0014) - no per-page deriving. Matched →
  // the managed primary; otherwise the raw masters render as external.
  let mirrorUpstream: { id: string; name: string } | null = null;
  let mirrorExternal: string[] = [];
  if (isReadOnlyZone && (zone.masters?.length ?? 0) > 0) {
    const upstreamId = derivedUpstreamFor(selected.id, zone.name);
    const upstream = upstreamId ? await findPdnsServerById(upstreamId) : null;
    if (upstream) mirrorUpstream = { id: upstream.id, name: upstream.name };
    else mirrorExternal = (zone.masters ?? []).map(normalizeMaster);
  }
  const canCreate = ops.rrsets && zoneCan("record.create");
  const canUpdate = ops.rrsets && zoneCan("record.update");
  const canDelete = ops.rrsets && zoneCan("record.delete");
  const canEdit = canCreate || canUpdate || canDelete;
  // `masters` (which primaries a mirror pulls from) is editable on a read-only
  // zone, so the settings panel stays writable there for users with zone.update.
  const canEditSettings = canUpdate || (isReadOnlyZone && zoneCan("zone.update"));
  // Zone creation isn't grantable per-zone - it's a global capability.
  const canCreateZone = globalPermissions.has("zone.create");
  const canDeleteZone = zoneCan("zone.delete");
  // audit.read is an admin-wide (global-only) permission.
  const canReadAudit = globalPermissions.has("audit.read");
  // The Access tab reveals user emails + team membership, so gate it on
  // `user.read`. Anyone able to manage / list users can also see who
  // can act on this zone.
  const canReadAccess = globalPermissions.has("user.read");
  const canReadDnssec = zoneCan("dnssec.read");
  const canReadMetadata = zoneCan("metadata.read");

  // Direct ?tab=sync / ?tab=statistics on a polling-off install bounces
  // back to the default records view with an error flash toast - these
  // surfaces are powered by the background poller, which is opt-in
  // (`PDNS_BACKGROUND_POLLING=true`). See lib/env.ts + #57.
  if (!pdnsBackgroundPollingEnabled && (requestedTab === "sync" || requestedTab === "statistics")) {
    const back = `/zones/${encodeURIComponent(zoneId)}?server=${encodeURIComponent(selected.slug)}&flash=polling-required&need=${encodeURIComponent(requestedTab === "sync" ? "per-zone Sync" : "per-zone Statistics")}`;
    redirect(back);
  }

  const tab: ZoneTab =
    requestedTab === "history" && canReadAudit
      ? "history"
      : requestedTab === "access" && canReadAccess
        ? "access"
        : requestedTab === "soa"
          ? "soa"
          : requestedTab === "settings"
            ? "settings"
            : requestedTab === "dnssec" && canReadDnssec
              ? "dnssec"
              : requestedTab === "metadata" && canReadMetadata
                ? "metadata"
                : requestedTab === "statistics"
                  ? "statistics"
                  : requestedTab === "sync"
                    ? "sync"
                    : "records";

  // All four post-zone fetches run in parallel - audit query, last
  // edit lookup, and the live sync probe to every secondary. Now we
  // know primary's serial so the sync probe returns valid verdicts.
  const auditEntriesPromise: Promise<ZoneAuditEntryClient[]> =
    tab === "history" && canReadAudit
      ? zoneAuditLog(auditSlugs, zone.name, 100).then((rows) =>
          rows
            .filter((e) => e.action !== "zone.notify")
            .map((e) => ({
              id: e.id,
              ts: e.ts.toISOString(),
              actorType: e.actorType,
              actorEmail: e.actorEmail,
              actorName: e.actorName,
              action: e.action,
              resourceType: e.resourceType,
              resourceId: e.resourceId,
              before: e.before ? redactSnapshot(e.before) : null,
              after: e.after ? redactSnapshot(e.after) : null,
              requestId: e.requestId,
            })),
        )
      : Promise.resolve([]);

  const lastEditPromise = canReadAudit
    ? latestZoneEdit(auditSlugs, zone.name)
    : Promise.resolve(null);

  const secondaryStatusesPromise = checkZoneSync(selected, zone.name, zone.serial ?? null);

  const [auditEntries, lastEdit, secondaryStatuses] = await Promise.all([
    auditEntriesPromise,
    lastEditPromise,
    secondaryStatusesPromise,
  ]);

  const pdnsHttpByRequestId = await fetchPdnsHttpByRequestIds(auditEntries);
  const syncVerdict = {
    inSync: secondaryStatuses.length === 0 || secondaryStatuses.every((s) => s.state === "in-sync"),
  };

  return (
    <div className="space-y-6">
      <ZoneHeader
        zone={zone}
        zoneIdEncoded={encodeURIComponent(zoneId)}
        server={{ name: selected.name, slug: selected.slug }}
        cluster={clusterContext ? { name: clusterContext.name, slug: clusterContext.slug } : null}
        lastEdit={lastEdit}
        canReadAudit={canReadAudit}
        canCreateZone={canCreateZone}
        // null hides the header chip's sync mode for the standalone /
        // polling-off path; the subscriber still listens for mutation
        // refresh events.
        inSync={pdnsBackgroundPollingEnabled ? syncVerdict.inSync : null}
      />

      {isReadOnlyZone ? (
        <div className="flex items-start gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-sm">
          <Lock
            aria-hidden
            className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--color-fg-muted)]"
          />
          <p>
            <strong>Read-only mirror.</strong> This is a {zone.kind} zone - its records and DNSSEC
            are served from its primary over AXFR and can&apos;t be edited here. Replication
            settings (masters, transfer metadata) remain editable.
            {mirrorUpstream ? (
              <span className="text-[color:var(--color-fg-muted)]">
                {" "}
                Mirrors {mirrorUpstream.name}.
              </span>
            ) : mirrorExternal.length > 0 ? (
              <span className="text-[color:var(--color-fg-muted)]">
                {" "}
                Mirrors external {mirrorExternal.join(", ")}.
              </span>
            ) : null}
          </p>
        </div>
      ) : null}

      <div id="zone-tabs-anchor" className="scroll-mt-4">
        <ZoneTabs
          active={tab}
          zoneIdEncoded={encodeURIComponent(zoneId)}
          serverSlug={selected.slug}
          canReadDnssec={canReadDnssec}
          canReadMetadata={canReadMetadata}
          canReadAudit={canReadAudit}
          canReadAccess={canReadAccess}
          showPollingFeatures={pdnsBackgroundPollingEnabled}
        />
      </div>
      <ScrollToTab anchorId="zone-tabs-anchor" />

      {/*
       * `key={tab}` makes React treat each tab switch as a fresh
       * subtree - the Suspense boundary re-runs and shows its fallback
       * while async children (DnssecSection / MetadataSection) fetch
       * from PDNS. Synchronous tabs flicker through the fallback for
       * an imperceptible moment because nothing actually suspends.
       */}
      <Suspense key={tab} fallback={<TabBodySkeleton tab={tab} />}>
        {tab === "records" ? (
          canEdit ? (
            <EditableRecordTable
              zoneName={zone.name}
              rrsets={nonSoaRrsets.map((rr) => ({
                name: rr.name,
                type: rr.type,
                ttl: rr.ttl,
                records: rr.records.map((r) => ({
                  content: r.content,
                  ...(r.disabled !== undefined ? { disabled: r.disabled } : {}),
                })),
                comment: joinRRsetComments(rr.comments),
              }))}
              serverSlug={selected.slug}
              zoneIdEncoded={encodeURIComponent(zone.id)}
              canCreate={canCreate}
              canUpdate={canUpdate}
              canDelete={canDelete}
            />
          ) : (
            <RecordTable
              zoneName={zone.name}
              rrsets={nonSoaRrsets.map((rr) => ({
                name: rr.name,
                type: rr.type,
                ttl: rr.ttl,
                records: rr.records.map((r) => ({
                  content: r.content,
                  ...(r.disabled !== undefined ? { disabled: r.disabled } : {}),
                })),
                ...(Array.isArray(rr.comments)
                  ? { comments: rr.comments as Array<{ content?: string }> }
                  : {}),
              }))}
            />
          )
        ) : tab === "soa" ? (
          <SoaPanel
            zoneName={zone.name}
            serverSlug={selected.slug}
            zoneIdEncoded={encodeURIComponent(zone.id)}
            current={soaFields}
            ttl={soaTtl}
            canEdit={canUpdate}
          />
        ) : tab === "settings" ? (
          <div className="space-y-6">
            <ZoneSettingsPanel
              zoneIdEncoded={encodeURIComponent(zone.id)}
              serverSlug={selected.slug}
              initial={{
                kind: zone.kind,
                ...(zone.masters !== undefined ? { masters: zone.masters } : {}),
                ...(zone.soa_edit !== undefined ? { soa_edit: zone.soa_edit } : {}),
                ...(zone.soa_edit_api !== undefined ? { soa_edit_api: zone.soa_edit_api } : {}),
                ...(zone.api_rectify !== undefined ? { api_rectify: zone.api_rectify } : {}),
              }}
              canEdit={canEditSettings}
            />
            <ZoneDangerZone
              zoneIdEncoded={encodeURIComponent(zone.id)}
              serverSlug={selected.slug}
              zoneName={zone.name}
              canDelete={canDeleteZone}
            />
          </div>
        ) : tab === "dnssec" ? (
          <DnssecSection
            zoneIdEncoded={encodeURIComponent(zoneId)}
            zoneName={zone.name}
            selected={selected}
            canRead={canReadDnssec}
            canConfigure={ops.dnssec && zoneCan("dnssec.configure")}
          />
        ) : tab === "metadata" ? (
          <MetadataSection
            zoneIdEncoded={encodeURIComponent(zoneId)}
            zoneName={zone.name}
            selected={selected}
            canRead={canReadMetadata}
            canWrite={zoneCan("metadata.write")}
            // Authoritative kinds serve AXFR - only they get the friendly TSIG
            // transfer-key selector (mirrors manage AXFR-MASTER-TSIG via the raw editor).
            showTsigTransfer={zone.kind === "Master" || zone.kind === "Primary"}
          />
        ) : tab === "statistics" ? (
          <ZoneStatisticsSection serverSlugs={auditSlugs} zoneName={zone.name} />
        ) : tab === "sync" ? (
          // tab === "sync"
          // Cluster (peer) comparison only for a TRUE multi-primary group - ≥2
          // write-capable peers and no secondaries. A primary+secondaries group
          // (one writable peer mirrored by secondaries) uses primary→secondary
          // sync, which compares `selected` against its group's mirrors.
          clusterContext && clusterContext.peers.length >= 2 && secondaryStatuses.length === 0 ? (
            <SyncSection
              mode="cluster"
              peers={clusterContext.peers}
              zoneName={zone.name}
              cluster={{
                id: clusterContext.id,
                name: clusterContext.name,
                slug: clusterContext.slug,
              }}
            />
          ) : (
            <SyncSection mode="primary-secondaries" primary={selected} zone={zone} />
          )
        ) : tab === "access" ? (
          <AccessSection serverId={selected.id} zoneName={zone.name} />
        ) : (
          <ZoneChangeLog
            entries={auditEntries}
            zoneName={zone.name}
            pdnsHttpByRequestId={pdnsHttpByRequestId}
          />
        )}
      </Suspense>
    </div>
  );
}

/**
 * Flatten PDNS' rrset comment bag into a single string for the editor.
 * PDNS attaches comments at the rrset level as `{ content, account,
 * modified_at }` objects; we join their `content` fields with " · " so
 * a multi-comment rrset still reads naturally in a single-line field.
 */
/**
 * Pull the raw PDNS HTTP rows for every audit entry's correlation id
 * in a single round-trip, then transform into the client component's
 * shape (Date → ISO, jsonb → typed-ish). Returns an empty map when no
 * entries carry a requestId - older rows from before that column existed.
 */
async function fetchPdnsHttpByRequestIds(
  entries: ReadonlyArray<{ requestId: string | null }>,
): Promise<Map<string, PdnsHttpLogEntry[]>> {
  const ids = entries
    .map((e) => e.requestId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return new Map();
  const [grouped, servers] = await Promise.all([
    findPdnsRequestsByRequestIds([...new Set(ids)]),
    listAllPdnsServers(),
  ]);
  // Lookups: id → server, slug → server. Slug fallback covers older
  // rows from before `serverDbId` was populated.
  const byId = new Map(servers.map((s) => [s.id, s]));
  const bySlug = new Map(servers.map((s) => [s.slug, s]));
  const out = new Map<string, PdnsHttpLogEntry[]>();
  for (const [reqId, rows] of grouped) {
    out.set(
      reqId,
      rows.map((row) => {
        const server =
          (row.serverId ? byId.get(row.serverId) : null) ??
          (row.serverSlug ? bySlug.get(row.serverSlug) : null) ??
          null;
        return {
          id: String(row.id),
          ts: row.ts.toISOString(),
          serverSlug: row.serverSlug ?? null,
          serverName: server?.name ?? null,
          serverDbId: server?.id ?? null,
          op: row.op,
          method: row.method,
          url: row.url,
          requestHeaders: row.requestHeaders ?? null,
          requestBody: row.requestBody,
          responseStatus: row.responseStatus ?? null,
          error: row.error ?? null,
        };
      }),
    );
  }
  return out;
}

function joinRRsetComments(comments: readonly unknown[] | undefined): string {
  if (!comments || comments.length === 0) return "";
  return comments
    .map((c) => {
      if (!c || typeof c !== "object") return "";
      const content = (c as { content?: unknown }).content;
      return typeof content === "string" ? content : "";
    })
    .filter((s) => s.length > 0)
    .join(" · ");
}

/** SOA parse is best-effort - if PDNS returns something unexpected we render
 *  the panel with defaults so the operator can rewrite it. */
function parseSoaSafely(content: string | null): SoaFields | null {
  if (!content) return null;
  try {
    return parseSoaContent(content);
  } catch {
    return null;
  }
}
