"use client";

/**
 * app/(app)/zones/auto-ptr/_components/ptr-reconciler.tsx
 *
 * The reverse DNS reconciler: one row per address found in an A/AAAA record
 * anywhere in the fleet, compared with the PTR that exists for it today.
 *
 * Fetches `GET /api/admin/pdns/auto-ptr/report` on mount (slow: it reads
 * every zone, so the page shell paints first) and rectifies through
 * `POST /api/admin/pdns/auto-ptr/rectify`, which runs the same planner, the
 * same permission checks and the same audit rows as the record editor's
 * auto-PTR. The outcomes come back in the editor's `AutoPtrOutcome` shape so
 * the toast reads identically in both places.
 *
 * What is and is not automated here, on purpose:
 *
 *   - "Rectify all fixable" covers only `missing` and `mismatch` rows. Those
 *     have exactly one forward name, so the PTR to write is unambiguous.
 *   - `ambiguous` rows (several forward names on one address) need the
 *     operator to pick which name the PTR says; a default is preselected but
 *     the row is only written once selected or clicked.
 *   - `orphan` rows (a PTR with no forward record anywhere we scanned) are
 *     removed only on an explicit per-row or selected action. The forward
 *     record may live in a zone this installation does not host.
 *
 * Selection is keyed by the report's stable row id and cleared after every
 * run, because the rows are rebuilt from a fresh report.
 */

import { type ColumnDef } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { SkeletonTable } from "@/components/ui/skeleton";
import { mutate } from "@/lib/client/api-fetch";
import { type AutoPtrOutcome, describePtrOutcome, summarizePtrOutcomes } from "@/lib/dns/auto-ptr";

// ---------------------------------------------------------------- contract

const REPORT_URL = "/api/admin/pdns/auto-ptr/report";
const RECTIFY_URL = "/api/admin/pdns/auto-ptr/rectify";
/** The rectify route caps one call at this many items; longer runs are chunked. */
const RECTIFY_BATCH_SIZE = 500;

type PtrStatus = "ok" | "missing" | "mismatch" | "ambiguous" | "orphan" | "unhosted";

interface ForwardRecord {
  zone: string;
  server: string;
  name: string;
  type: "A" | "AAAA";
  ttl: number;
  disabled: boolean;
}

interface PtrReconcileRow {
  id: string;
  ip: string;
  family: 4 | 6;
  owner: string;
  reverseZone: string | null;
  reverseServer: string | null;
  forward: ForwardRecord[];
  currentTargets: string[];
  currentTtl: number | null;
  status: PtrStatus;
  suggestedTarget: string | null;
  canWrite: boolean;
}

interface PtrReconcileReport {
  generatedAt: string;
  backends: Array<{ slug: string; name: string }>;
  reverseZones: Array<{ name: string; server: string; writable: boolean }>;
  rows: PtrReconcileRow[];
  stats: Record<PtrStatus, number> & { zonesScanned: number; recordsScanned: number };
  errors: Array<{ server: string; zone?: string; message: string }>;
}

interface RectifyItem {
  ip: string;
  action: "set" | "remove";
  target: string;
  ttl?: number;
}

// ---------------------------------------------------------------- vocabulary

const STATUS_ORDER: readonly PtrStatus[] = [
  "missing",
  "mismatch",
  "ambiguous",
  "orphan",
  "ok",
  "unhosted",
];

const STATUS_LABEL: Record<PtrStatus, string> = {
  ok: "OK",
  missing: "Missing",
  mismatch: "Mismatch",
  ambiguous: "Ambiguous",
  orphan: "Orphan",
  unhosted: "Not hosted",
};

const STATUS_HINT: Record<PtrStatus, string> = {
  ok: "The PTR already points at the forward name.",
  missing: "A forward record exists but no PTR does.",
  mismatch: "A PTR exists but points at a different name, or at several.",
  ambiguous: "Several forward names share this address; a PTR can only name one.",
  orphan: "A PTR exists but no scanned zone has a forward record for this address.",
  unhosted: "No hosted reverse zone covers this address, so nothing can be written.",
};

/** The statuses an operator has to look at; the default filter and the selectable set. */
const ATTENTION_STATUSES: ReadonlySet<PtrStatus> = new Set([
  "missing",
  "mismatch",
  "ambiguous",
  "orphan",
]);

/** The statuses "Rectify all fixable" may touch without a human choice. */
const FIXABLE_STATUSES: ReadonlySet<PtrStatus> = new Set(["missing", "mismatch"]);

function statusTone(status: PtrStatus): "warn" | "error" | "muted" {
  if (status === "orphan") return "error";
  if (ATTENTION_STATUSES.has(status)) return "warn";
  return "muted";
}

const CHIP_TONE_CLASS = {
  warn: "border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]",
  error:
    "border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 text-[color:var(--color-error-fg)]",
  muted: "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]",
} as const;

const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-2 py-1 text-xs whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";
const DANGER_BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded border border-[color:var(--color-error)] px-2 py-1 text-xs whitespace-nowrap text-[color:var(--color-error-fg)] hover:bg-[color:var(--color-error)]/10 disabled:cursor-not-allowed disabled:opacity-50";
const TOOLBAR_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5 text-sm font-medium whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------- helpers

/** Distinct forward names on a row, alphabetical, as the planner's tie-break orders them. */
function forwardNames(row: PtrReconcileRow): string[] {
  return [...new Set(row.forward.map((f) => f.name.toLowerCase()))].sort();
}

/** TTL the PTR mirrors: the forward record carrying `target`, else the first forward record. */
function forwardTtlFor(row: PtrReconcileRow, target: string): number | undefined {
  const match = row.forward.find((f) => f.name.toLowerCase() === target.toLowerCase());
  return (match ?? row.forward[0])?.ttl;
}

function isSelectable(row: PtrReconcileRow): boolean {
  return row.canWrite && ATTENTION_STATUSES.has(row.status);
}

function noWriteTitle(row: PtrReconcileRow): string | undefined {
  if (row.canWrite) return undefined;
  return `You can't write records in ${row.reverseZone ?? "the reverse zone"}.`;
}

/**
 * The rectify item a row translates to, given the operator's pick for
 * ambiguous rows. Null for rows nothing can be done about.
 */
function rectifyItemFor(row: PtrReconcileRow, pick: string | undefined): RectifyItem | null {
  if (!row.canWrite) return null;
  switch (row.status) {
    case "missing":
    case "mismatch": {
      const target = row.suggestedTarget ?? forwardNames(row)[0];
      if (!target) return null;
      return { ip: row.ip, action: "set", target, ttl: forwardTtlFor(row, target) };
    }
    case "ambiguous": {
      const target = pick ?? row.suggestedTarget ?? forwardNames(row)[0];
      if (!target) return null;
      return { ip: row.ip, action: "set", target, ttl: forwardTtlFor(row, target) };
    }
    case "orphan": {
      const target = row.currentTargets[0];
      if (!target) return null;
      return { ip: row.ip, action: "remove", target };
    }
    default:
      return null;
  }
}

function countActions(items: readonly RectifyItem[]): { writes: number; removes: number } {
  let writes = 0;
  let removes = 0;
  for (const item of items) {
    if (item.action === "set") writes++;
    else removes++;
  }
  return { writes, removes };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function confirmDescription(items: readonly RectifyItem[]): string {
  const { writes, removes } = countActions(items);
  const parts: string[] = [];
  if (writes) parts.push(`writes ${plural(writes, "PTR record")}`);
  if (removes) parts.push(`removes ${plural(removes, "PTR record")}`);
  return `This ${parts.join(" and ")} in the hosted reverse zones. Every change is audited like a record edit.`;
}

// ---------------------------------------------------------------- component

export function PtrReconciler() {
  const { confirm, toast } = useDialog();
  const [report, setReport] = useState<PtrReconcileReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeStatuses, setActiveStatuses] = useState<ReadonlySet<PtrStatus>>(ATTENTION_STATUSES);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const loadReport = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const result = await mutate<PtrReconcileReport>(REPORT_URL);
    if (!result.ok) {
      setLoadError(result.error);
      setReport(null);
    } else {
      setReport(result.data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  const rows = useMemo(() => report?.rows ?? [], [report]);
  const visibleRows = useMemo(
    () => rows.filter((r) => activeStatuses.has(r.status)),
    [rows, activeStatuses],
  );
  const selectableVisible = useMemo(() => visibleRows.filter(isSelectable), [visibleRows]);
  const allVisibleSelected =
    selectableVisible.length > 0 && selectableVisible.every((r) => selected.has(r.id));
  const fixableRows = useMemo(
    () => rows.filter((r) => r.canWrite && FIXABLE_STATUSES.has(r.status)),
    [rows],
  );

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  function toggleStatus(status: PtrStatus) {
    setActiveStatuses((cur) => {
      const next = new Set(cur);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

  function toggleSelected(id: string, on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllVisible(on: boolean) {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const r of selectableVisible) {
        if (on) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  }

  function toggleExpanded(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Send the items in route-sized batches, then report the combined outcome
   * the way the record editor does: a one-line summary, loudest level wins,
   * followed by the lines of anything that was not simply written.
   */
  async function rectify(items: readonly RectifyItem[]) {
    if (items.length === 0 || busy) return;
    setBusy(true);
    try {
      const outcomes: AutoPtrOutcome[] = [];
      for (let i = 0; i < items.length; i += RECTIFY_BATCH_SIZE) {
        const batch = items.slice(i, i + RECTIFY_BATCH_SIZE);
        const result = await mutate<{ outcomes: AutoPtrOutcome[] }>(RECTIFY_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: batch }),
        });
        if (!result.ok) {
          toast({
            kind: "error",
            title: "Rectify failed",
            description:
              outcomes.length > 0
                ? `${result.error} ${outcomes.length} earlier ${outcomes.length === 1 ? "item was" : "items were"} applied.`
                : result.error,
          });
          return;
        }
        outcomes.push(...(result.data?.outcomes ?? []));
      }
      const summary = summarizePtrOutcomes(outcomes);
      const detail = outcomes
        .filter((o) => o.action === "skip" || o.action === "conflict" || o.action === "failed")
        .map(describePtrOutcome)
        .join(" ");
      toast({
        kind: summary.level === "error" ? "error" : summary.level === "warn" ? "warn" : "success",
        title: summary.level === "error" ? "Reverse DNS partly failed" : "Reverse DNS",
        description: [summary.text || "Nothing needed changing.", detail].filter(Boolean).join(" "),
      });
    } finally {
      setBusy(false);
      setSelected(new Set());
      void loadReport();
    }
  }

  async function rectifySelected() {
    const items: RectifyItem[] = [];
    for (const id of selected) {
      const row = rowById.get(id);
      if (!row) continue;
      const item = rectifyItemFor(row, picks[id]);
      if (item) items.push(item);
    }
    if (items.length === 0) return;
    const ok = await confirm({
      title: `Rectify ${plural(items.length, "selected address")}?`,
      description: confirmDescription(items),
      confirmLabel: "Rectify",
      variant: countActions(items).removes > 0 ? "danger" : "default",
    });
    if (!ok) return;
    await rectify(items);
  }

  async function rectifyAllFixable() {
    const items = fixableRows
      .map((row) => rectifyItemFor(row, undefined))
      .filter((item): item is RectifyItem => item !== null);
    if (items.length === 0) return;
    const ok = await confirm({
      title: `Write ${plural(items.length, "PTR record")}?`,
      description: `${confirmDescription(items)} Ambiguous and orphan rows are left for you to decide.`,
      confirmLabel: "Write PTRs",
    });
    if (!ok) return;
    await rectify(items);
  }

  async function rectifyRow(row: PtrReconcileRow) {
    const item = rectifyItemFor(row, picks[row.id]);
    if (!item) return;
    if (item.action === "remove") {
      const ok = await confirm({
        title: "Remove this PTR?",
        description: `Removes the PTR for ${row.ip} in ${row.reverseZone ?? "its reverse zone"}, which points at ${item.target}. No scanned zone has a forward record for this address, but one may exist in a zone hosted elsewhere.`,
        confirmLabel: "Remove PTR",
        variant: "danger",
      });
      if (!ok) return;
    }
    await rectify([item]);
  }

  const columns = useMemo<Array<ColumnDef<PtrReconcileRow, unknown>>>(
    () => [
      {
        accessorKey: "ip",
        header: "Address",
        cell: ({ row }) => {
          const r = row.original;
          const selectable = isSelectable(r);
          return (
            <span className="inline-flex items-center gap-2">
              <Checkbox
                checked={selected.has(r.id)}
                onChange={(on) => toggleSelected(r.id, on)}
                disabled={!selectable || busy}
                ariaLabel={`Select ${r.ip}`}
              />
              <code className="font-mono text-sm break-all">{r.ip}</code>
            </span>
          );
        },
        meta: { className: "w-[18%]" },
      },
      {
        id: "forward",
        header: "Forward records",
        accessorFn: (r) => r.forward.map((f) => `${f.name} ${f.zone}`).join(" "),
        cell: ({ row }) => <ForwardCell row={row.original} />,
        meta: { className: "w-[26%]" },
      },
      {
        id: "currentPtr",
        header: "Current PTR",
        accessorFn: (r) => r.currentTargets.join(" "),
        cell: ({ row }) => {
          const targets = row.original.currentTargets;
          if (targets.length === 0) {
            return <span className="text-xs text-[color:var(--color-fg-muted)]">none</span>;
          }
          return (
            <ul className="space-y-0.5">
              {targets.map((t) => (
                <li key={t} className="font-mono text-xs break-all">
                  {t}
                </li>
              ))}
            </ul>
          );
        },
        meta: { className: "w-[18%]" },
      },
      {
        id: "reverseZone",
        header: "Reverse zone",
        accessorFn: (r) => r.reverseZone ?? "not hosted",
        cell: ({ row }) => {
          const r = row.original;
          if (!r.reverseZone) {
            return <span className="text-xs text-[color:var(--color-fg-muted)]">not hosted</span>;
          }
          return (
            <span className="block">
              <span className="block font-mono text-xs break-all">{r.reverseZone}</span>
              {r.reverseServer ? (
                <span className="block text-xs text-[color:var(--color-fg-muted)]">
                  {r.reverseServer}
                </span>
              ) : null}
            </span>
          );
        },
        meta: { className: "w-[16%]" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
        sortingFn: (a, b) =>
          STATUS_ORDER.indexOf(a.original.status) - STATUS_ORDER.indexOf(b.original.status),
        meta: { className: "w-[10%]" },
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            row={row.original}
            pick={picks[row.original.id]}
            busy={busy}
            expanded={expanded.has(row.original.id)}
            onPick={(name) => setPicks((cur) => ({ ...cur, [row.original.id]: name }))}
            onRectify={() => void rectifyRow(row.original)}
            onToggleExpanded={() => toggleExpanded(row.original.id)}
          />
        ),
      },
    ],
    // The cells close over selection, picks and expansion so the memo must
    // follow them; rectifyRow is stable enough in practice because the row
    // it needs is passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, picks, expanded, busy],
  );

  if (loading && !report) {
    return (
      <div className="space-y-3">
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-[color:var(--color-fg-muted)]"
        >
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          Reading every zone on every backend. On a large installation this takes a while.
        </p>
        <SkeletonTable rows={8} cols={6} />
      </div>
    );
  }

  if (loadError && !report) {
    return (
      <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error-fg)]">
        <strong>Could not build the report.</strong> {loadError}
        <div className="mt-3">
          <button type="button" onClick={() => void loadReport()} className={TOOLBAR_BUTTON_CLASS}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!report) return null;

  const selectedCount = [...selected].filter((id) => rowById.has(id)).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-xs text-[color:var(--color-fg-muted)]">
          {plural(report.stats.recordsScanned, "address record")} across{" "}
          {plural(report.stats.zonesScanned, "zone")} on {plural(report.backends.length, "backend")}
          , {plural(report.reverseZones.length, "hosted reverse zone")}. Generated{" "}
          <LocalTime ts={report.generatedAt} />.
        </p>
        <button
          type="button"
          onClick={() => void loadReport()}
          disabled={loading || busy}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {report.errors.length > 0 ? (
        <div className="rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs">
          <strong>
            {plural(report.errors.length, "zone")} could not be read; the report is incomplete.
          </strong>
          <ul className="mt-2 list-disc pl-5">
            {report.errors.map((e, idx) => (
              <li key={`${e.server}|${e.zone ?? ""}|${idx}`}>
                <code className="font-mono">{e.zone ? `${e.zone} on ${e.server}` : e.server}</code>{" "}
                - {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {STATUS_ORDER.map((status) => {
          const active = activeStatuses.has(status);
          const tone = statusTone(status);
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              title={STATUS_HINT[status]}
              onClick={() => toggleStatus(status)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? CHIP_TONE_CLASS[tone]
                  : "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] opacity-70 hover:opacity-100"
              }`}
            >
              {STATUS_LABEL[status]}
              <span className="tabular-nums">{report.stats[status]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          checked={allVisibleSelected}
          onChange={toggleAllVisible}
          disabled={selectableVisible.length === 0 || busy}
          label={
            <span className="text-sm">
              Select all {selectableVisible.length} shown
              {selectedCount > 0 ? (
                <span className="text-[color:var(--color-fg-muted)]">
                  {" "}
                  ({selectedCount} selected)
                </span>
              ) : null}
            </span>
          }
        />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void rectifySelected()}
            disabled={selectedCount === 0 || busy}
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Wand2 className="h-4 w-4" aria-hidden />
            Rectify selected ({selectedCount})
          </button>
          <button
            type="button"
            onClick={() => void rectifyAllFixable()}
            disabled={fixableRows.length === 0 || busy}
            title="Writes the PTR for every missing or mismatched address you may write. Ambiguous and orphan rows need a human choice and are left alone."
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Wand2 className="h-4 w-4" aria-hidden />
            Rectify all fixable ({fixableRows.length})
          </button>
        </div>
      </div>
      <p className="text-xs text-[color:var(--color-fg-muted)]">
        Fixable means missing or mismatched: one forward name, so the PTR to write is clear.
        Ambiguous rows need a name picked and orphans need a decision; select those by hand.
      </p>

      <DataTable
        columns={columns}
        data={visibleRows}
        searchPlaceholder="Search by address, name or zone…"
        searchShortcut
        pageSize={25}
        initialSort={[{ id: "status", desc: false }]}
        stateKey="auto-ptr"
        layout="fixed"
        noDataMessage={
          rows.length === 0
            ? "No A or AAAA records found in any zone."
            : "No rows match the selected statuses."
        }
        renderRowDetail={(row) => (expanded.has(row.id) ? <RowDetail row={row} /> : null)}
      />
    </div>
  );
}

// ---------------------------------------------------------------- cells

function StatusChip({ status }: { status: PtrStatus }) {
  return (
    <span
      title={STATUS_HINT[status]}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_TONE_CLASS[statusTone(status)]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function ForwardCell({ row }: { row: PtrReconcileRow }) {
  if (row.forward.length === 0) {
    return <span className="text-xs text-[color:var(--color-fg-muted)]">none</span>;
  }
  return (
    <ul className="space-y-1">
      {row.forward.map((f) => (
        <li
          key={`${f.server}|${f.zone}|${f.name}|${f.type}`}
          className={f.disabled ? "text-[color:var(--color-fg-muted)]" : ""}
        >
          <span className="block font-mono text-xs break-all">
            {f.name}
            {f.disabled ? " (disabled)" : ""}
          </span>
          <span className="block text-xs text-[color:var(--color-fg-muted)]">
            {f.type} in {f.zone} on {f.server}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RowActions({
  row,
  pick,
  busy,
  expanded,
  onPick,
  onRectify,
  onToggleExpanded,
}: {
  row: PtrReconcileRow;
  pick: string | undefined;
  busy: boolean;
  expanded: boolean;
  onPick: (name: string) => void;
  onRectify: () => void;
  onToggleExpanded: () => void;
}) {
  const title = noWriteTitle(row);
  const disabled = busy || !row.canWrite;
  let action: React.ReactNode = null;
  if (row.status === "missing" || row.status === "mismatch") {
    action = (
      <button
        type="button"
        onClick={onRectify}
        disabled={disabled}
        title={title}
        className={BUTTON_CLASS}
      >
        <Wand2 className="h-3.5 w-3.5" aria-hidden />
        Write PTR
      </button>
    );
  } else if (row.status === "ambiguous") {
    const names = forwardNames(row);
    const value = pick ?? row.suggestedTarget?.toLowerCase() ?? names[0] ?? "";
    action = (
      <span className="flex flex-wrap items-center gap-2">
        <SelectMenu
          value={value}
          options={names.map((n) => ({ value: n, label: n }))}
          onChange={onPick}
          disabled={disabled}
          ariaLabel={`PTR target for ${row.ip}`}
          className="max-w-full min-w-[12rem] text-xs"
        />
        <button
          type="button"
          onClick={onRectify}
          disabled={disabled}
          title={title}
          className={BUTTON_CLASS}
        >
          <Wand2 className="h-3.5 w-3.5" aria-hidden />
          Write PTR
        </button>
      </span>
    );
  } else if (row.status === "orphan") {
    action = (
      <button
        type="button"
        onClick={onRectify}
        disabled={disabled}
        title={title}
        className={DANGER_BUTTON_CLASS}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
        Remove PTR
      </button>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {action}
      <button
        type="button"
        onClick={onToggleExpanded}
        aria-expanded={expanded}
        aria-label={expanded ? `Hide details for ${row.ip}` : `Show details for ${row.ip}`}
        className={BUTTON_CLASS}
      >
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        )}
        Details
      </button>
    </span>
  );
}

function RowDetail({ row }: { row: PtrReconcileRow }) {
  const names = forwardNames(row);
  return (
    <div className="space-y-2 pt-3 text-xs">
      <p>
        <StatusChip status={row.status} />{" "}
        <span className="text-[color:var(--color-fg-muted)]">{STATUS_HINT[row.status]}</span>
        {row.status === "ambiguous" && row.suggestedTarget ? (
          <span className="text-[color:var(--color-fg-muted)]">
            {" "}
            Preselected: <code className="font-mono">{row.suggestedTarget}</code>
            {row.currentTargets.some((t) => t.toLowerCase() === row.suggestedTarget?.toLowerCase())
              ? ", the name the PTR says today."
              : `, first of ${names.length} names alphabetically.`}
          </span>
        ) : null}
        {!row.canWrite && row.reverseZone ? (
          <span className="text-[color:var(--color-warn-fg)]"> {noWriteTitle(row)}</span>
        ) : null}
      </p>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
        <dt className="text-[color:var(--color-fg-muted)]">PTR owner</dt>
        <dd className="font-mono break-all">{row.owner}</dd>
        <dt className="text-[color:var(--color-fg-muted)]">Reverse zone</dt>
        <dd className="font-mono break-all">
          {row.reverseZone ? `${row.reverseZone} on ${row.reverseServer ?? "?"}` : "not hosted"}
        </dd>
        <dt className="text-[color:var(--color-fg-muted)]">Current PTR</dt>
        <dd className="font-mono break-all">
          {row.currentTargets.length === 0
            ? "none"
            : `${row.currentTargets.join(", ")}${row.currentTtl !== null ? ` (TTL ${row.currentTtl})` : ""}`}
        </dd>
        <dt className="text-[color:var(--color-fg-muted)]">Forward records</dt>
        <dd>
          {row.forward.length === 0 ? (
            "none"
          ) : (
            <ul className="space-y-0.5">
              {row.forward.map((f) => (
                <li
                  key={`${f.server}|${f.zone}|${f.name}|${f.type}`}
                  className={`font-mono break-all ${f.disabled ? "text-[color:var(--color-fg-muted)]" : ""}`}
                >
                  {f.name} {f.type} {row.ip} TTL {f.ttl}
                  {f.disabled ? " (disabled)" : ""} · {f.zone} on {f.server}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </div>
  );
}
