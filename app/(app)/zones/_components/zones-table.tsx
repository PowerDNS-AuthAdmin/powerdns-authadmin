"use client";

/**
 * app/(app)/zones/_components/zones-table.tsx
 *
 * Client wrapper that feeds the amalgamated zones list into the reusable
 * DataTable. The page fetches zones from every logical backend
 * (standalone primary, primary+secondaries primary, or cluster) and
 * merges them — each row carries its source backend so the link target
 * and Sync rendering branch correctly.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Lock, Unlock } from "lucide-react";
import { DataTable } from "@/components/ui/data-table";
import { SyncIndicator } from "@/components/ui/sync-indicator";
import { freshnessOf, freshnessOfDay } from "@/lib/freshness";
import { isReverseZone } from "@/lib/dns/zone-kind";
import { displayZoneName } from "@/lib/dns/zone-name";

type ScopeFilter = "all" | "forward" | "reverse";
const SCOPE_STORAGE_KEY = "pda.zones.scope";

function isValidScope(s: unknown): s is ScopeFilter {
  return s === "all" || s === "forward" || s === "reverse";
}

/**
 * DNSSEC status cell: a green closed padlock when the zone is signed, a
 * muted open padlock when it isn't — quicker to scan down the column than
 * "on"/"off" text. Title + sr-only text keep it accessible.
 */
function DnssecCell({ on }: { on: boolean }) {
  return on ? (
    <span
      className="inline-flex items-center gap-1 text-xs text-[color:var(--color-success)]"
      title="DNSSEC signed"
    >
      <Lock aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">DNSSEC on</span>
    </span>
  ) : (
    <span
      className="inline-flex items-center gap-1 text-xs text-[color:var(--color-fg-subtle)]"
      title="DNSSEC off"
    >
      <Unlock aria-hidden className="h-3.5 w-3.5" />
      <span className="sr-only">DNSSEC off</span>
    </span>
  );
}

export interface ZoneRow {
  id: string;
  name: string;
  kind: string;
  serial: number | null;
  dnssec: boolean;
  /** The backend this row was read from. The view + edit link resolves
   *  to a concrete server slug regardless of whether the source was a
   *  cluster (any peer suffices). */
  backend: {
    kind: "server" | "cluster";
    /** Human-readable name for the table cell. */
    name: string;
    /** When kind = "cluster", the cluster slug — used for the link
     *  target so writes route through chooseWritePeer. When kind =
     *  "server", null. */
    clusterSlug: string | null;
    /** Concrete server slug — for kind=server, the row itself; for
     *  kind=cluster, any peer (reads identically across peers). */
    serverSlug: string;
  };
  /**
   * ISO timestamp of the latest known edit for this zone. Sourced
   * from the audit log when available; falls back to a `YYYYMMDDnn`
   * SOA-serial-derived date when audit is silent. Null when neither
   * source yields a date or the actor doesn't have `audit.read`.
   */
  lastEditIso: string | null;
  /**
   * Where `lastEditIso` came from — surfaced as a small "(SOA)" hint
   * when serial-derived so operators can tell apart "we logged this
   * recently" from "we inferred this from the serial."
   */
  lastEditSource: "audit" | "serial" | null;
  /**
   * Per-peer sync state. For a cluster the entries are the OTHER peers'
   * serials relative to the representative peer's read; for a primary
   * with Secondaries, the entries are the Secondaries.
   *
   * Empty when the source is a standalone primary — Sync cell renders
   * "—". The display is the same shape ("synced" / "desynced") for
   * both cluster and primary+secondary cases because the operator-
   * facing question is identical: are all peers serving the same view.
   */
  syncStates: ReadonlyArray<{
    slug: string;
    name: string;
    state: "in-sync" | "ahead" | "lagging" | "missing" | "error";
    serial: number | null;
  }>;
  /** Worst sync state across peers (drives the column's color). Null
   *  means "no peers to compare" → the Sync cell renders "—". */
  syncWorst: "in-sync" | "ahead" | "lagging" | "missing" | "error" | null;
  /** True when this row is a read-only mirror (an unpinned secondary's zone
   *  that no primary serves). The row links to a read-only zone detail. */
  readOnly?: boolean;
}

interface ZonesTableProps {
  zones: ZoneRow[];
  /**
   * Whether to render the "Last edit" column. When false the column
   * is omitted entirely (not just blanked) so the table stays
   * compact for actors without audit.read.
   */
  showLastEdit: boolean;
}

/** Detail URL for a zone row — cluster-backed zones carry ?cluster=, standalone
 *  ones carry ?server=. Shared by the name link and the clickable row. */
function zoneHref(row: ZoneRow): string {
  return row.backend.clusterSlug
    ? `/zones/${encodeURIComponent(row.id)}?cluster=${encodeURIComponent(row.backend.clusterSlug)}`
    : `/zones/${encodeURIComponent(row.id)}?server=${encodeURIComponent(row.backend.serverSlug)}`;
}

export function ZonesTable({ zones, showLastEdit }: ZonesTableProps) {
  const columns = useMemo<Array<ColumnDef<ZoneRow, unknown>>>(() => {
    const cols: Array<ColumnDef<ZoneRow, unknown>> = [
      {
        accessorKey: "name",
        header: "Name",
        cell: (ctx) => {
          const row = ctx.row.original;
          return (
            <Link
              href={zoneHref(row)}
              prefetch={false}
              className="font-medium text-[color:var(--color-accent)] hover:underline"
            >
              {displayZoneName(ctx.getValue<string>())}
            </Link>
          );
        },
      },
      {
        id: "backend",
        accessorFn: (row) => row.backend.name,
        header: "Backend",
        cell: (ctx) => {
          const row = ctx.row.original;
          const isCluster = row.backend.kind === "cluster";
          return (
            <span className="text-xs">
              {row.backend.name}
              {isCluster ? (
                <span className="ml-2 rounded bg-[color:var(--color-accent)]/15 px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-accent)] uppercase">
                  cluster
                </span>
              ) : null}
              {row.readOnly ? (
                <span
                  className="ml-2 rounded bg-[color:var(--color-bg-muted)] px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase"
                  title="Read-only mirror — unpinned secondary"
                >
                  read-only
                </span>
              ) : null}
            </span>
          );
        },
        meta: { className: "w-[18%]" },
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: (ctx) => <span className="text-xs">{ctx.getValue<string>()}</span>,
        meta: { className: "w-[10%]" },
      },
      {
        accessorKey: "serial",
        header: "Serial",
        cell: (ctx) => {
          const value = ctx.getValue<number | null>();
          return <span className="font-mono text-xs">{value ?? "—"}</span>;
        },
        meta: { className: "w-[12%]" },
      },
      {
        accessorKey: "dnssec",
        header: "DNSSEC",
        cell: (ctx) => <DnssecCell on={ctx.getValue<boolean>()} />,
        meta: { className: "w-[8%]" },
      },
      {
        id: "sync",
        // Numeric rank so `desc: true` orders desync first, in-sync
        // last. Standalone primaries (no peers, `syncWorst === null`)
        // sort below in-sync so a fleet of all-synced + standalones
        // shows standalones at the bottom of the section — operators
        // care about replicated state first.
        accessorFn: (row) => syncRank(row.syncWorst),
        sortingFn: "basic" as const,
        header: "Sync",
        cell: (ctx) => <SyncCell row={ctx.row.original} />,
        meta: { className: "w-[14%]" },
      },
    ];

    if (showLastEdit) {
      cols.push({
        accessorKey: "lastEditIso",
        header: "Last edit",
        cell: (ctx) => {
          const row = ctx.row.original;
          const iso = row.lastEditIso;
          if (!iso) return <span className="text-xs text-[color:var(--color-fg-muted)]">—</span>;
          const fromSerial = row.lastEditSource === "serial";
          const label = fromSerial ? freshnessOfDay(iso).label : freshnessOf(iso).label;
          const titleText = fromSerial
            ? `${iso} — inferred from SOA serial (no audit log entry for this or a later day)`
            : iso;
          return (
            <span className="text-xs text-[color:var(--color-fg-muted)]" title={titleText}>
              {label}
            </span>
          );
        },
        meta: { className: "w-[14%]" },
      });
    }

    return cols;
  }, [showLastEdit]);

  // Forward / Reverse / All segmented filter above the table. Persisted to
  // localStorage so the choice sticks across navigations (same pattern as
  // the DataTable's own sort/pageSize persistence).
  const [scope, setScope] = useState<ScopeFilter>("all");
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY);
      if (raw && isValidScope(raw)) setScope(raw);
    } catch {
      // Corrupt / blocked localStorage — keep the default.
    }
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, scope);
    } catch {
      // Quota / blocked — non-fatal.
    }
  }, [scope]);

  const counts = useMemo(() => {
    let forward = 0;
    let reverse = 0;
    for (const z of zones) {
      if (isReverseZone(z.name)) reverse++;
      else forward++;
    }
    return { all: zones.length, forward, reverse };
  }, [zones]);

  const filtered = useMemo(() => {
    if (scope === "all") return zones;
    const wantReverse = scope === "reverse";
    return zones.filter((z) => isReverseZone(z.name) === wantReverse);
  }, [zones, scope]);

  return (
    <div className="space-y-3">
      <ScopeTabs scope={scope} counts={counts} onChange={setScope} />
      <DataTable
        columns={columns}
        data={filtered}
        searchPlaceholder="Search zones by name or backend…"
        // Default order: desynced first (Sync desc), then name asc.
        // When every row is in-sync the Sync rank ties and Name asc
        // becomes the visible order — i.e. "show me anything that
        // needs attention first; otherwise alphabetical."
        initialSort={[
          { id: "sync", desc: true },
          { id: "name", desc: false },
        ]}
        sortParam="sort"
        pageSizeParam="pageSize"
        stateKey="zones"
        rowHref={zoneHref}
        noDataMessage={
          scope === "forward"
            ? "No forward zones across any backend yet."
            : scope === "reverse"
              ? "No reverse zones across any backend yet."
              : "No zones across any backend yet."
        }
      />
    </div>
  );
}

function ScopeTabs({
  scope,
  counts,
  onChange,
}: {
  scope: ScopeFilter;
  counts: { all: number; forward: number; reverse: number };
  onChange: (next: ScopeFilter) => void;
}) {
  const tabs: Array<{ id: ScopeFilter; label: string; count: number }> = [
    { id: "all", label: "All", count: counts.all },
    { id: "forward", label: "Forward", count: counts.forward },
    { id: "reverse", label: "Reverse", count: counts.reverse },
  ];
  return (
    <div
      role="tablist"
      aria-label="Zone scope filter"
      className="inline-flex rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-0.5 text-sm"
    >
      {tabs.map((t) => {
        const active = t.id === scope;
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={
              active
                ? "rounded bg-[color:var(--color-accent)] px-3 py-1 font-medium text-[color:var(--color-accent-fg)]"
                : "rounded px-3 py-1 text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
            }
          >
            {t.label}
            <span
              className={
                active
                  ? "ml-1.5 text-[color:var(--color-accent-fg)]/80"
                  : "ml-1.5 text-[color:var(--color-fg-subtle)]"
              }
            >
              ({t.count})
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Map a worst-state across peers to a sortable rank. Higher = more
 *  desynced. Standalone primaries (no peers) get a rank below
 *  in-sync so they sit at the bottom of an "all green" list. */
function syncRank(state: ZoneRow["syncWorst"]): number {
  switch (state) {
    case "error":
      return 5;
    case "missing":
      return 4;
    case "lagging":
      return 3;
    case "ahead":
      return 2;
    case "in-sync":
      return 1;
    default:
      return 0;
  }
}

function SyncCell({ row }: { row: ZoneRow }) {
  // Standalone primary (no secondaries, not in a cluster) → no peers
  // to compare → render "—". Same convention the dashboard uses.
  if (row.syncStates.length === 0) {
    return <span className="text-xs text-[color:var(--color-fg-muted)]">—</span>;
  }
  const worst = row.syncWorst;
  const isSynced = worst === "in-sync";
  const tone: "success" | "warn" | "error" = isSynced
    ? "success"
    : worst === "ahead" || worst === "lagging"
      ? "warn"
      : "error";
  const textClass =
    tone === "success"
      ? "text-[color:var(--color-success)]"
      : tone === "warn"
        ? "text-[color:var(--color-warn)]"
        : "text-[color:var(--color-error)]";
  const label = isSynced ? "synced" : "desynced";
  // Include the row's own backend in the count — `syncStates` enumerates the
  // OTHER peers (secondaries, or non-anchor cluster peers), so +1 surfaces
  // the total fleet size the operator is looking at.
  const total = row.syncStates.length + 1;
  const detail = row.syncStates
    .map((s) => `${s.name}: ${s.state}${s.serial !== null ? ` (serial ${s.serial})` : ""}`)
    .join("\n");
  return (
    <span title={detail}>
      <span
        className={`pda-sync-chip-pad inline-flex items-center gap-1.5 rounded-full border border-[color:var(--color-border)] bg-[color:var(--color-bg)] text-[0.625rem] font-medium tracking-wide uppercase ${textClass}`}
      >
        <SyncIndicator state={isSynced ? "synced" : "desynced"} size={14} tone={tone} />
        {label}
        <span className="text-[color:var(--color-fg-muted)] tabular-nums">{total}</span>
      </span>
    </span>
  );
}
