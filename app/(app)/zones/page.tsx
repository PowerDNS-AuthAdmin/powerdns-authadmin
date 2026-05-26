/**
 * app/(app)/zones/page.tsx
 *
 * Amalgamated zone list across every configured logical backend. A
 * "logical backend" is either a standalone PDNS server or a cluster
 * (the cluster shows as ONE row in the source column; its individual
 * peers don't get their own listing because they all see the same
 * data).
 *
 * SINGLE SOURCE OF TRUTH: this page does NOT call PowerDNS itself. It asks the
 * app-wide broker to ensure a recent observation (`ensureBackendsObserved`) and
 * then reads the shared store — the zone-state cache for zones, the live
 * reachability store for up/down, the (cache-backed) sync helper for sync state.
 * So this page and the servers list + bell always agree, and a backend the
 * broker can't reach surfaces here exactly as it does there (no per-page probe,
 * no raw connection error leaked to the UI).
 *
 * Per-row Sync state:
 *   • Standalone primary (no Secondaries)  → "—"
 *   • Primary + Secondaries                → all Secondaries' serials vs primary
 *   • Cluster                              → all peers' serials vs the
 *                                            representative peer's
 *
 * Permission: `zone.read`.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CreateButton } from "@/components/ui/create-button";
import { requireUserForPage } from "@/lib/auth/require-user";
import {
  listSelectableBackends,
  type SelectableBackend,
} from "@/lib/db/repositories/selectable-backends";
import { listUngroupedSecondaries } from "@/lib/db/repositories/pdns-servers";
import { isReadOnlyZoneKind } from "@/lib/pdns/writable-kind";
import { latestEditTimestampsByZone } from "@/lib/db/repositories/audit-log";
import { checkZonesSyncBatch, type SecondarySyncStatus } from "@/lib/pdns/sync";
import { parseSoaSerialDate } from "@/lib/dns/soa-serial";
import { readCachedZones, type CachedZoneSnapshot } from "@/lib/pdns/zone-state-cache";
import { derivedParentOf } from "@/lib/pdns/topology-cache";
import { ensureBackendsObserved } from "@/lib/realtime/zone-poller";
import { backendUnreachability } from "@/lib/realtime/backend-status";
import type { PdnsServer } from "@/lib/db/schema";
import { ZonesTable, type ZoneRow } from "./_components/zones-table";
import { ServerRealtimeSubscriber } from "./_components/server-realtime-subscriber";

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

  // Ask the broker to ensure a recent observation, then read its store. Serves
  // from the warm store on a hot path; runs/joins one poll when cold or stale.
  await ensureBackendsObserved();

  const backends = await listSelectableBackends();
  // Unpinned secondaries (mirrors of an external/unmanaged primary) are
  // browsable read-only, so they count as "a backend exists" even when no
  // primary or cluster is configured.
  const readOnlySecondaries = await listUngroupedSecondaries();
  if (backends.length === 0 && readOnlySecondaries.length === 0) {
    return <NoServersState canCreateServer={canCreateServer} />;
  }

  // Build the amalgamated list from the broker store — no PDNS calls here.
  const fetched = await Promise.all(backends.map((b) => rowsFromBackend(b)));

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

  // Unpinned secondaries (mirroring an external/unmanaged primary) contribute
  // their zones read-only. They join the amalgamated list and are de-duped with
  // everything else below. Display-only; writes to a secondary are blocked
  // server-side.
  for (const s of readOnlySecondaries) {
    const r = readOnlySecondaryRows(s);
    if (r.error) {
      errors.push({ backendName: r.label, message: r.error });
      continue;
    }
    for (const row of r.rows) allRows.push(row);
  }

  // De-dup by zone name. The SAME zone surfaces from multiple backends — a
  // primary plus its mirrors, two primaries seeded with the same name, or two
  // secondaries of one external primary. Keep ONE row per name: an authoritative
  // (writable) row always wins over a read-only mirror; within the same tier the
  // first wins (backends arrive name-ordered). So a zone always resolves to its
  // primary, or — if none is managed — to the first secondary that serves it.
  const { kept: dedupedRows, hidden: hiddenRows } = dedupeZonesByName(allRows);

  // Restrict the amalgamated list to zones the viewer may actually read.
  // Global zone.read sees all; otherwise only granted zone names. (The
  // zone detail page + API enforce per-(server,zone) precisely; this list
  // filter is the display-side counterpart.)
  const visibleRows = globalZoneRead
    ? dedupedRows
    : dedupedRows.filter((r) => grantedZoneNames.has(r.name));

  // Surface what de-dup collapsed (scoped to zones the viewer can see), so an
  // operator knows the same zone is served by a backend that ISN'T shown — but
  // ONLY when that's surprising. A read-only secondary that mirrors a managed
  // primary is normal replication, not a duplicate worth flagging. The app knows
  // a secondary belongs to a primary two ways (ADR-0014), and BOTH must silence:
  //   • grouped — these never reach `hiddenRows` at all (folded into the group's
  //     single primary row, so they don't produce a separate row here); and
  //   • derived — ungrouped, but the poller resolved its masters[] to a managed
  //     primary, so the servers page nests it under that primary. `hiddenRows`
  //     DOES contain these (they come in via `readOnlySecondaryRows`), so we
  //     filter them out by the same signal the servers page uses for nesting:
  //     `derivedParentOf` must resolve to a primary that is STILL PRESENT. (A
  //     parent that's been deleted leaves a stale mapping; the servers page drops
  //     it to "Standalone secondaries", and so must we — otherwise an orphaned
  //     secondary would silently stop warning.)
  // What remains — truly orphaned secondaries (no managed primary, grouped or
  // derived) and authoritative name-collisions (the same zone on two primaries) —
  // is exactly what should warn.
  const managedPrimaryIds = new Set<string>();
  for (const b of backends) {
    if (b.kind === "server") managedPrimaryIds.add(b.server.id);
    else for (const p of b.peers) managedPrimaryIds.add(p.id);
  }
  const derivedSecondarySlugs = new Set(
    readOnlySecondaries
      .filter((s) => {
        const parent = derivedParentOf(s.id);
        return parent !== null && managedPrimaryIds.has(parent);
      })
      .map((s) => s.slug),
  );
  const visibleHidden = (
    globalZoneRead ? hiddenRows : hiddenRows.filter((r) => grantedZoneNames.has(r.name))
  ).filter((r) => !derivedSecondarySlugs.has(r.backend.serverSlug ?? ""));
  const hiddenBackends = new Map<string, { name: string; type: string }>();
  for (const r of visibleHidden) {
    const type = r.readOnly
      ? "secondary"
      : r.backend.kind === "cluster"
        ? "cluster peer"
        : "primary";
    hiddenBackends.set(`${r.backend.name} ${type}`, { name: r.backend.name, type });
  }
  const hiddenSummary =
    visibleHidden.length > 0
      ? { count: visibleHidden.length, backends: [...hiddenBackends.values()] }
      : null;

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
  for (const s of readOnlySecondaries) channelSlugs.push(s.slug);

  // "anyLagging" drives the chip's fast-mode color — true when ANY row
  // on the amalgamated list isn't fully in-sync. Standalone primaries
  // have null syncWorst and don't contribute.
  const anyLagging = visibleRows.some((r) => r.syncWorst !== null && r.syncWorst !== "in-sync");

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
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
        {canCreateZone ? <CreateButton href="/zones/new" label="Create zone" /> : null}
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

      {hiddenSummary ? (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs">
          <strong>
            {hiddenSummary.count} duplicate zone{hiddenSummary.count === 1 ? "" : "s"} hidden.
          </strong>{" "}
          Each zone is listed once (resolved to its primary, or the first secondary when no primary
          is managed). These copies are on backends with no managed primary — standalone secondaries
          mirroring an unmanaged primary, or the same name on another primary. Also served by:{" "}
          {hiddenSummary.backends.map((b, i) => (
            <span key={`${b.name} ${b.type}`}>
              {i > 0 ? ", " : ""}
              <code className="font-mono">{b.name}</code> ({b.type})
            </span>
          ))}
          .
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

/** Generic, non-leaky reachability message (no raw connect error — S-12). */
function unreachableMessage(kind: "down" | "auth"): string {
  return kind === "auth"
    ? "API rejected the configured key (401/403)."
    : "Backend unreachable — the app hasn't reached its API recently.";
}

/**
 * Build zone rows for one logical backend from the broker store (zone-state
 * cache + live reachability). For a cluster, reads from the first reachable peer
 * (peers share data); a backend the broker can't reach yields an error envelope
 * so it surfaces consistently with the servers list + bell.
 */
async function rowsFromBackend(backend: SelectableBackend): Promise<FetchResult> {
  const label = backend.kind === "cluster" ? backend.cluster.name : backend.server.name;

  // The peer whose cached zone set we read. Any reachable peer is equivalent for
  // a cluster (shared storage); fall back to the representative for the slug.
  const readPeer =
    backend.kind === "cluster"
      ? (backend.peers.find((p) => backendUnreachability(p.id) === null) ??
        backend.representativeServer)
      : backend.server;
  const lastEditServerSlug = readPeer.slug;

  const unreach = backendUnreachability(readPeer.id);
  const cached = readCachedZones(readPeer.id);
  if (unreach || !cached) {
    return {
      label,
      lastEditServerSlug,
      rows: [],
      error: unreachableMessage(unreach ?? "down"),
    };
  }
  const zones = [...cached.zones.values()];

  // Sync state — branches on the group's composition (ADR-0014). All variants
  // read serials from the cache (poller-maintained), never live.
  let syncByZone: Map<string, SecondarySyncStatus[]>;
  const zoneSerials = zones.map((z) => ({ name: z.name, serial: z.serial }));
  if (backend.kind === "server" || backend.secondaries.length > 0) {
    // Standalone primary, or a primary + its secondaries → primary→secondary.
    syncByZone = await checkZonesSyncBatch(
      backend.kind === "cluster" ? backend.representativeServer : backend.server,
      zoneSerials,
    );
  } else {
    // True multi-primary cluster — compare every peer's cached serials.
    syncByZone = clusterSyncFromCache(backend, readPeer, zones);
  }

  const rowsBackend: ZoneRow["backend"] = {
    kind: backend.kind,
    name: label,
    clusterSlug: backend.kind === "cluster" ? backend.cluster.slug : null,
    serverSlug: readPeer.slug,
  };

  const rows = zones.map((z) => toZoneRow(z, rowsBackend, syncByZone.get(z.name) ?? []));
  return { label, lastEditServerSlug, rows, error: null };
}

/**
 * One row per zone name across the whole fleet. An authoritative (writable) row
 * beats a read-only mirror of the same name; among rows of the same tier the
 * first wins (rows arrive in a stable, name-ordered backend sequence). Net: a
 * zone resolves to its primary, or to the first secondary when no primary serves
 * it. Map preserves first-insertion order, so an in-place replacement keeps the
 * row's original position.
 */
function dedupeZonesByName(rows: readonly ZoneRow[]): { kept: ZoneRow[]; hidden: ZoneRow[] } {
  const byName = new Map<string, ZoneRow>();
  const hidden: ZoneRow[] = [];
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (!existing) {
      byName.set(row.name, row);
      continue;
    }
    // Prefer an authoritative row over a read-only mirror; the displaced one is
    // hidden. Otherwise this duplicate is the one hidden.
    if (existing.readOnly && !row.readOnly) {
      byName.set(row.name, row);
      hidden.push(existing);
    } else {
      hidden.push(row);
    }
  }
  return { kept: [...byName.values()], hidden };
}

/**
 * Read-only rows for an unpinned secondary — a mirror of a primary the app
 * doesn't manage — from the broker store. Every cached zone is emitted; the
 * caller's `dedupeZonesByName` drops any a primary (or an earlier secondary)
 * already covers. An unreachable mirror reports an error envelope. No sync
 * column (no app-side primary to compare); "last edit" falls back to the
 * SOA-serial date.
 */
function readOnlySecondaryRows(secondary: PdnsServer): {
  label: string;
  rows: ZoneRow[];
  error: string | null;
} {
  const label = secondary.name;
  const unreach = backendUnreachability(secondary.id);
  const cached = readCachedZones(secondary.id);
  if (unreach || !cached) {
    return { label, rows: [], error: unreachableMessage(unreach ?? "down") };
  }
  const rows: ZoneRow[] = [];
  for (const z of cached.zones.values()) {
    const fold = foldLastEdit(z.serial, null);
    rows.push({
      id: z.id,
      name: z.name,
      kind: z.kind,
      serial: z.serial,
      dnssec: z.dnssec,
      backend: { kind: "server", name: label, clusterSlug: null, serverSlug: secondary.slug },
      lastEditIso: fold.iso,
      lastEditSource: fold.source,
      syncStates: [],
      syncWorst: null,
      readOnly: isReadOnlyZoneKind(z.kind),
    });
  }
  return { label, rows, error: null };
}

/**
 * Multi-primary cluster sync from the zone-state cache — the representative
 * peer's serial is the per-zone source of truth; every other peer's cached
 * serial is compared against it. No PDNS calls (mirrors `checkZonesSyncBatch`).
 */
function clusterSyncFromCache(
  backend: Extract<SelectableBackend, { kind: "cluster" }>,
  readPeer: PdnsServer,
  primaryZones: readonly CachedZoneSnapshot[],
): Map<string, SecondarySyncStatus[]> {
  // Per-peer cached serials, in memory.
  const peerSerials = backend.peers.map((p) => {
    const entry = readCachedZones(p.id);
    const serials = new Map<string, number | null>();
    if (entry) for (const z of entry.zones.values()) serials.set(z.name, z.serial);
    return { peer: p, serials, reachable: backendUnreachability(p.id) === null && entry !== null };
  });

  const out = new Map<string, SecondarySyncStatus[]>();
  for (const z of primaryZones) {
    const repSerial = z.serial;
    const entries: SecondarySyncStatus[] = [];
    for (const ps of peerSerials) {
      if (ps.peer.id === readPeer.id) continue;
      let state: SecondarySyncStatus["state"];
      let observed: number | null = ps.serials.get(z.name) ?? null;
      if (!ps.reachable) {
        state = "error";
        observed = null;
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
        error: null,
      });
    }
    out.set(z.name, entries);
  }
  return out;
}

function toZoneRow(
  zone: CachedZoneSnapshot,
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
    serial: zone.serial,
    dnssec: zone.dnssec,
    // Read-only by zone kind — a Slave/Secondary/Consumer zone is an AXFR
    // mirror even when it lives on an otherwise-writable (primary) backend.
    readOnly: isReadOnlyZoneKind(zone.kind),
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
