/**
 * app/(app)/zones/page.tsx
 *
 * Amalgamated zone list across every configured logical backend. A
 * "logical backend" is either a standalone PDNS server or a cluster
 * (the cluster shows as ONE row in the source column; its individual
 * peers don't get their own listing because they all see the same
 * data).
 *
 * Per-row Sync state:
 *   • Standalone primary (no Secondaries)  → "—"
 *   • Primary + Secondaries                → all Secondaries' serials
 *                                            vs the primary's
 *   • Cluster                              → all peers' serials vs the
 *                                            representative peer's; any
 *                                            mismatch ⇒ desynced
 *
 * Permission: `zone.read`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUserForPage } from "@/lib/auth/require-user";
import {
  listSelectableBackends,
  type SelectableBackend,
} from "@/lib/db/repositories/selectable-backends";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { choosePeer } from "@/lib/pdns/cluster-picker";
import { latestEditTimestampsByZone } from "@/lib/db/repositories/audit-log";
import { checkZonesSyncBatch, type SecondarySyncStatus } from "@/lib/pdns/sync";
import { parseSoaSerialDate } from "@/lib/dns/soa-serial";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import type { PdnsServer } from "@/lib/db/schema";
import { ZonesTable, type ZoneRow } from "./_components/zones-table";
import { ServerRealtimeSubscriber } from "./_components/server-realtime-subscriber";
import { ensurePollerRunning } from "@/lib/realtime/zone-poller";
import type { PdnsZoneSummary } from "@/lib/pdns/types";

export const metadata: Metadata = { title: "Zones" };

export default async function ZonesPage() {
  // Authenticate, then decide zone visibility. A user with GLOBAL zone.read
  // sees every backend's zones; a non-global user (zone_grants only) sees
  // only the zones they're granted. A type-level CASL check would leak every
  // zone name to a team-scoped role — see lib/rbac/ability.ts:globalPermissionsOf.
  const { globalPermissions, zoneGrants } = await requireUserForPage();
  const globalZoneRead = globalPermissions.has("zone.read");
  if (!globalZoneRead && zoneGrants.length === 0) {
    redirect("/dashboard?flash=forbidden&need=zone.read");
  }
  // Grant zone names are stored canonical (lowercase + trailing dot), which
  // matches the canonical names PDNS returns in the list below.
  const grantedZoneNames = new Set(zoneGrants.map((g) => g.zoneName));
  const canCreateServer = globalPermissions.has("server.create");
  const canCreateZone = globalPermissions.has("zone.create");
  const canReadAudit = globalPermissions.has("audit.read");

  // Heartbeat: keep the unified app-wide poller alive so SSE + zone
  // cache + sync chips stay fresh without per-request PDNS calls.
  ensurePollerRunning();

  const backends = await listSelectableBackends();
  if (backends.length === 0) {
    return <NoServersState canCreateServer={canCreateServer} />;
  }

  // Fetch zones from every logical backend in parallel. Each fetch is
  // best-effort: one unreachable backend doesn't blank the whole page.
  const fetched = await Promise.all(backends.map((b) => fetchFromBackend(b)));

  const errors: Array<{ backendName: string; message: string }> = [];
  const allRows: ZoneRow[] = [];
  for (const result of fetched) {
    if (result.error) {
      errors.push({ backendName: result.label, message: result.error });
      continue;
    }
    for (const row of result.rows) allRows.push(row);
  }

  // Audit-derived "last edit" enrichment. Per-backend batched lookup
  // keyed on the representative server's slug — for cluster zones whose
  // writes route across multiple peers, audit timestamps may be
  // partially observable; the serial-derived fallback covers the gap.
  if (canReadAudit) {
    await Promise.all(
      fetched.map(async (result) => {
        if (!result.rows.length) return;
        const lastEdits = await latestEditTimestampsByZone(
          result.lastEditServerSlug,
          result.rows.map((r) => r.name),
        );
        for (const row of result.rows) {
          const lastEdit = lastEdits.get(row.name) ?? null;
          const fold = foldLastEdit(row.serial, lastEdit);
          row.lastEditIso = fold.iso;
          row.lastEditSource = fold.source;
        }
      }),
    );
  }

  // Restrict the amalgamated list to zones the viewer may actually read.
  // Global zone.read sees all; otherwise only granted zone names. (The
  // zone detail page + API enforce per-(server,zone) precisely; this list
  // filter is the display-side counterpart.)
  const visibleRows = globalZoneRead
    ? allRows
    : allRows.filter((r) => grantedZoneNames.has(r.name));

  // Collect every channel slug events for this page may arrive on. For
  // primary+secondary topologies the poller pumps events on the
  // primary's slug; for clusters every peer publishes under its own
  // slug. The subscriber listens on the union so a write to any
  // backend on this amalgamated list triggers a refresh.
  const channelSlugs: string[] = [];
  for (const b of backends) {
    if (b.kind === "server") channelSlugs.push(b.server.slug);
    else for (const p of b.peers) channelSlugs.push(p.slug);
  }

  // "anyLagging" drives the chip's fast-mode color — true when ANY row
  // on the amalgamated list isn't fully in-sync. Standalone primaries
  // have null syncWorst and don't contribute.
  const anyLagging = visibleRows.some((r) => r.syncWorst !== null && r.syncWorst !== "in-sync");

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <div className="flex items-baseline gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Zones</h1>
            <ServerRealtimeSubscriber serverSlugs={channelSlugs} inSync={!anyLagging} />
          </div>
          <p className="mt-1 text-sm text-[color:var(--color-fg-muted)]">
            {visibleRows.length} zone{visibleRows.length === 1 ? "" : "s"} across {backends.length}{" "}
            backend{backends.length === 1 ? "" : "s"}
            {errors.length > 0 ? ` · ${errors.length} unreachable` : ""}.
          </p>
        </div>
        {canCreateZone ? (
          <Link
            href="/zones/new"
            className="rounded-md bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
          >
            Create zone
          </Link>
        ) : null}
      </header>

      {errors.length > 0 ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error)]">
          <strong>Some backends are unreachable.</strong>
          <ul className="mt-2 list-disc pl-5 text-xs">
            {errors.map((e) => (
              <li key={e.backendName}>
                <code className="font-mono">{e.backendName}</code> — {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ZonesTable zones={visibleRows} showLastEdit={canReadAudit} />
    </div>
  );
}

interface FetchResult {
  label: string;
  lastEditServerSlug: string;
  rows: ZoneRow[];
  error: string | null;
}

/**
 * Fetch zones + sync state from one logical backend. Errors are
 * captured into the returned envelope so a single broken backend
 * doesn't fail the whole page render.
 */
async function fetchFromBackend(backend: SelectableBackend): Promise<FetchResult> {
  const label = backend.kind === "cluster" ? backend.cluster.name : backend.server.name;

  // For cluster backends the cluster's peer-selection strategy picks
  // which peer to read from — round_robin spreads requests across
  // peers, lowest_latency / least_load route to the healthiest. For
  // standalone servers there's only one choice.
  const readPeer =
    backend.kind === "cluster"
      ? ((await choosePeer(backend.cluster, backend.peers)) ?? backend.representativeServer)
      : backend.server;
  const lastEditServerSlug = readPeer.slug;

  let zones: PdnsZoneSummary[];
  try {
    const client = getPdnsClientForRow(readPeer);
    zones = await client.listZones();
  } catch (err) {
    const msg = err instanceof Error ? redact(err.message) : "unknown";
    logger.warn({ backend: label, kind: backend.kind, error: msg }, "zones.list.backend-failed");
    return { label, lastEditServerSlug, rows: [], error: msg };
  }

  // Sync state — branches on backend kind.
  let syncByZone: Map<string, SecondarySyncStatus[]>;
  if (backend.kind === "server") {
    // Primary + Secondaries (when Secondaries exist) → batched probe.
    // Empty map for standalone primaries, which is exactly the "—"
    // rendering signal the SyncCell already understands.
    syncByZone = await checkZonesSyncBatch(
      backend.server,
      zones.map((z) => ({ name: z.name, serial: z.serial ?? null })),
    );
  } else {
    // Cluster — probe every peer for the full zone list and compare
    // serials against the read peer's. Same operator-facing question:
    // are all peers serving the same view.
    syncByZone = await probeClusterSync(backend, readPeer, zones);
  }

  const rowsBackend: ZoneRow["backend"] = {
    kind: backend.kind,
    name: label,
    clusterSlug: backend.kind === "cluster" ? backend.cluster.slug : null,
    serverSlug: readPeer.slug,
  };

  const rows: ZoneRow[] = zones.map((z) => toZoneRow(z, rowsBackend, syncByZone.get(z.name) ?? []));
  return { label, lastEditServerSlug, rows, error: null };
}

/**
 * Probe every peer in a cluster and produce a SecondarySyncStatus[]
 * keyed on zone name. The representative peer (the one the page
 * already read from) is the source-of-truth; the other peers' serials
 * are compared against it.
 *
 * Mirrors the per-zone shape of `checkZonesSyncBatch` so the table's
 * Sync cell renders identically across topologies. "in-sync" means
 * the peer's serial matches the representative's.
 */
async function probeClusterSync(
  backend: Extract<SelectableBackend, { kind: "cluster" }>,
  /** The peer whose zone list the table is showing — its serials are
   *  the per-zone source-of-truth for the sync comparison. */
  readPeer: PdnsServer,
  primaryZones: readonly PdnsZoneSummary[],
): Promise<Map<string, SecondarySyncStatus[]>> {
  // Serials by (peer, zoneName). One listZones call per peer, then
  // per-zone lookups in memory.
  const peerSerials = await Promise.all(
    backend.peers.map(async (p) => {
      try {
        const client = getPdnsClientForRow(p);
        const list = await client.listZones();
        const m = new Map<string, number | null>();
        for (const z of list) m.set(z.name, z.serial ?? null);
        return { peer: p, serials: m, error: null as string | null };
      } catch (err) {
        return {
          peer: p,
          serials: new Map<string, number | null>(),
          error: err instanceof Error ? redact(err.message) : "unknown",
        };
      }
    }),
  );

  const repSerialByZone = new Map<string, number | null>();
  for (const z of primaryZones) repSerialByZone.set(z.name, z.serial ?? null);

  const out = new Map<string, SecondarySyncStatus[]>();
  for (const z of primaryZones) {
    const repSerial = repSerialByZone.get(z.name) ?? null;
    const entries: SecondarySyncStatus[] = [];
    for (const ps of peerSerials) {
      if (ps.peer.id === readPeer.id) continue;
      let state: SecondarySyncStatus["state"];
      let observed: number | null = ps.serials.get(z.name) ?? null;
      if (ps.error !== null) {
        state = "error";
      } else if (!ps.serials.has(z.name)) {
        state = "missing";
        observed = null;
      } else if (observed === null || repSerial === null) {
        state = "error";
      } else if (observed === repSerial) {
        state = "in-sync";
      } else if (observed < repSerial) {
        state = "lagging";
      } else {
        state = "ahead";
      }
      entries.push({
        server: ps.peer,
        state,
        primarySerial: repSerial,
        secondarySerial: observed,
        error: ps.error,
      });
    }
    out.set(z.name, entries);
  }
  return out;
}

function toZoneRow(
  zone: PdnsZoneSummary,
  backend: ZoneRow["backend"],
  sync: SecondarySyncStatus[],
): ZoneRow {
  // Worst-case sync verdict across peers/secondaries: error > missing
  // > lagging > ahead > in-sync. Drives the column's color.
  const order: Record<SecondarySyncStatus["state"], number> = {
    error: 4,
    missing: 3,
    lagging: 2,
    ahead: 1,
    "in-sync": 0,
  };
  let worst: SecondarySyncStatus["state"] | null = null;
  for (const s of sync) {
    if (!worst || order[s.state] > order[worst]) worst = s.state;
  }

  return {
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    serial: zone.serial ?? null,
    dnssec: zone.dnssec ?? false,
    backend,
    lastEditIso: null,
    lastEditSource: null,
    syncStates: sync.map((s) => ({
      slug: s.server.slug,
      name: s.server.name,
      state: s.state,
      serial: s.secondarySerial,
    })),
    syncWorst: worst,
  };
}

/**
 * Fold the audit timestamp and the SOA-serial-derived date into the
 * single "Last edit" value. Precedence:
 *   • Audit when at least as recent (UTC-day grain) as the serial.
 *   • Serial when strictly newer (caught a write outside our audit
 *     surface — older systems, pdnsutil, direct backend poke).
 *   • Either alone fills in for the missing other.
 */
function foldLastEdit(
  serialOrNull: number | null,
  lastEdit: Date | null,
): { iso: string | null; source: "audit" | "serial" | null } {
  const serialDate = parseSoaSerialDate(serialOrNull);
  if (lastEdit && serialDate) {
    const auditDay = Math.floor(lastEdit.getTime() / 86_400_000);
    const serialDay = Math.floor(serialDate.getTime() / 86_400_000);
    if (serialDay > auditDay) return { iso: serialDate.toISOString(), source: "serial" };
    return { iso: lastEdit.toISOString(), source: "audit" };
  }
  if (lastEdit) return { iso: lastEdit.toISOString(), source: "audit" };
  if (serialDate) return { iso: serialDate.toISOString(), source: "serial" };
  return { iso: null, source: null };
}

function NoServersState({ canCreateServer }: { canCreateServer: boolean }) {
  return (
    <div className="mx-auto max-w-xl rounded-md border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-8 text-center">
      <h1 className="text-lg font-semibold">No PowerDNS backends configured</h1>
      <p className="mt-2 text-sm text-[color:var(--color-fg-muted)]">
        {canCreateServer
          ? "Connect a PowerDNS Authoritative server (or define a cluster) to see and manage its zones."
          : "Ask an administrator to add a PowerDNS backend before you can manage zones."}
      </p>
      {canCreateServer ? (
        <Link
          href="/admin/servers/new"
          className="mt-4 inline-block rounded-md bg-[color:var(--color-accent)] px-4 py-2 text-sm font-medium text-[color:var(--color-accent-fg)] hover:opacity-95"
        >
          Add a PowerDNS server
        </Link>
      ) : null}
    </div>
  );
}
