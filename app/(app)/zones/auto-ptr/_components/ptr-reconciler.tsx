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
 *   - Every row can be selected, `ok` and `unhosted` included: operators
 *     audit by ticking what they have checked. Rectifying an `ok` row writes
 *     the PTR it already has (the API reports it `unchanged`); an `unhosted`
 *     row has nowhere to write, so "Rectify selected" skips it and says so.
 *
 * Rows carry the forward zone's horizon (ADR-0022): a public zone is matched
 * against public reverse zones, an internal one against internal reverse
 * zones, so the same address may appear once per horizon. For addresses no
 * hosted reverse zone covers, the server looks the PTR up through the
 * world's resolvers in the background and the row shows that answer instead.
 *
 * Selection is keyed by the report's stable row id and cleared after every
 * run, because the rows are rebuilt from a fresh report.
 */

import { type ColumnDef } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Globe, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { SkeletonTable } from "@/components/ui/skeleton";
import { mutate } from "@/lib/client/api-fetch";
import { type AutoPtrOutcome, describePtrOutcome, summarizePtrOutcomes } from "@/lib/dns/auto-ptr";
import { ZONE_HORIZONS, type ZoneHorizon } from "@/lib/dns/zone-horizon";

// ---------------------------------------------------------------- contract

const REPORT_URL = "/api/admin/pdns/auto-ptr/report";
const RECTIFY_URL = "/api/admin/pdns/auto-ptr/rectify";
const EXTERNAL_REFRESH_URL = "/api/admin/pdns/auto-ptr/external-refresh";
/** The rectify route caps one call at this many items; longer runs are chunked. */
const RECTIFY_BATCH_SIZE = 500;
const HTTP_TOO_MANY_REQUESTS = 429;

type PtrStatus = "ok" | "missing" | "mismatch" | "ambiguous" | "orphan" | "unhosted";

type ExternalPtrStatus = "pending" | "none" | "match" | "mismatch" | "error";

/** What the world's resolvers answer for an address we host no reverse zone for. */
interface ExternalPtr {
  status: ExternalPtrStatus;
  targets?: string[];
  resolver?: string | null;
  checkedAt?: string;
  error?: string;
}

interface ForwardRecord {
  zone: string;
  server: string;
  horizon: ZoneHorizon;
  name: string;
  type: "A" | "AAAA";
  ttl: number;
  disabled: boolean;
}

interface PtrReconcileRow {
  id: string;
  ip: string;
  family: 4 | 6;
  horizon: ZoneHorizon;
  owner: string;
  reverseZone: string | null;
  reverseServer: string | null;
  forward: ForwardRecord[];
  currentTargets: string[];
  currentTtl: number | null;
  status: PtrStatus;
  suggestedTarget: string | null;
  canWrite: boolean;
  /** Only on `unhosted` rows, and only once the background lookup has run. */
  external?: ExternalPtr;
}

interface PtrReconcileReport {
  generatedAt: string;
  backends: Array<{ slug: string; name: string }>;
  reverseZones: Array<{ name: string; server: string; writable: boolean; horizon: ZoneHorizon }>;
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

type HorizonFilter = "all" | ZoneHorizon;

// ---------------------------------------------------------------- vocabulary

const STATUS_ORDER: readonly PtrStatus[] = [
  "missing",
  "mismatch",
  "ambiguous",
  "orphan",
  "ok",
  "unhosted",
];

const ALL_STATUSES: ReadonlySet<PtrStatus> = new Set(STATUS_ORDER);

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
  unhosted:
    "No hosted reverse zone in this horizon covers the address, so nothing can be written here. The world's answer is shown instead.",
};

const HORIZON_LABEL: Record<ZoneHorizon, string> = {
  public: "Public",
  internal: "Internal",
};

const HORIZON_HINT: Record<ZoneHorizon, string> = {
  public: "Public forward zones, matched against public reverse zones.",
  internal:
    "Internal forward zones, matched against internal reverse zones (a reverse zone covering private address space counts as internal).",
};

const HORIZON_FILTERS: ReadonlyArray<{ value: HorizonFilter; label: string }> = [
  { value: "all", label: "All horizons" },
  ...ZONE_HORIZONS.map((h) => ({ value: h, label: HORIZON_LABEL[h] })),
];

const EXTERNAL_LABEL: Record<Exclude<ExternalPtrStatus, "match" | "mismatch">, string> = {
  pending: "looking up…",
  none: "no PTR upstream",
  error: "lookup failed",
};

/** The statuses an operator has to look at; drives the chip tones. */
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
  accent:
    "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]",
} as const;

const INACTIVE_CHIP_CLASS =
  "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] opacity-70 hover:opacity-100";
const FILTER_CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors";

/**
 * Same recipe as `ZoneHorizonBadge` (mono, uppercase, orange for internal) so
 * the horizon reads the same here as in the zones list; public gets a quiet
 * badge too because an empty cell in a dedicated column would look broken.
 */
const HORIZON_BADGE_CLASS: Record<ZoneHorizon, string> = {
  internal:
    "rounded bg-[color:var(--color-orange)]/15 px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-orange-fg)] uppercase",
  public:
    "rounded bg-[color:var(--color-bg-muted)] px-1 py-0.5 font-mono text-[0.625rem] tracking-wide text-[color:var(--color-fg-muted)] uppercase",
};

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

function noWriteTitle(row: PtrReconcileRow): string | undefined {
  if (row.canWrite) return undefined;
  return `You can't write records in ${row.reverseZone ?? "the reverse zone"}.`;
}

/**
 * The rectify item a row translates to, given the operator's pick for
 * ambiguous rows. Null for rows nothing can be done about: `unhosted` has no
 * reverse zone to write in, and rows the operator may not write would only
 * come back as `no-permission` skips, so they are not sent.
 */
function rectifyItemFor(row: PtrReconcileRow, pick: string | undefined): RectifyItem | null {
  if (!row.canWrite) return null;
  switch (row.status) {
    case "ok": {
      // Writing the PTR it already has: the planner answers `unchanged`.
      const target = row.suggestedTarget ?? row.currentTargets[0] ?? forwardNames(row)[0];
      if (!target) return null;
      return { ip: row.ip, action: "set", target, ttl: forwardTtlFor(row, target) };
    }
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
    case "unhosted":
      return null;
  }
}

interface SelectionPlan {
  items: RectifyItem[];
  /** Rows already correct, sent anyway so the operator gets an explicit `unchanged`. */
  alreadyCorrect: number;
  /** Rows with no hosted reverse zone: nothing to write. */
  unhosted: number;
  /** Rows the operator may not write: not sent. */
  unwritable: number;
}

/** Sort selected rows into what is sent and what is skipped, with the reasons for the toast. */
function planSelection(
  rows: readonly PtrReconcileRow[],
  picks: Readonly<Record<string, string>>,
): SelectionPlan {
  const plan: SelectionPlan = { items: [], alreadyCorrect: 0, unhosted: 0, unwritable: 0 };
  for (const row of rows) {
    if (row.status === "unhosted") {
      plan.unhosted++;
      continue;
    }
    if (!row.canWrite) {
      plan.unwritable++;
      continue;
    }
    const item = rectifyItemFor(row, picks[row.id]);
    if (!item) continue;
    if (row.status === "ok") plan.alreadyCorrect++;
    plan.items.push(item);
  }
  return plan;
}

/** The "skipped because" sentence for a selection; empty when nothing was skipped. */
function skippedNote(plan: SelectionPlan): string {
  const parts: string[] = [];
  if (plan.unhosted)
    parts.push(`${plural(plan.unhosted, "address")} not hosted here (nothing to write)`);
  if (plan.unwritable)
    parts.push(`${plural(plan.unwritable, "address")} in reverse zones you can't write`);
  return parts.length ? `Skipped ${parts.join(" and ")}.` : "";
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
  const [externalBusy, setExternalBusy] = useState(false);
  const [activeStatuses, setActiveStatuses] = useState<ReadonlySet<PtrStatus>>(ALL_STATUSES);
  const [horizonFilter, setHorizonFilter] = useState<HorizonFilter>("all");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [picks, setPicks] = useState<Readonly<Record<string, string>>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  /**
   * Load the report; `refresh` asks the server for a fresh scan, which it
   * grants at most once per 15 s and otherwise answers with the cached one.
   * Returns the report so the caller can tell which it got.
   */
  const loadReport = useCallback(
    async (opts: { refresh?: boolean } = {}): Promise<PtrReconcileReport | null> => {
      setLoading(true);
      setLoadError(null);
      const result = await mutate<PtrReconcileReport>(
        opts.refresh ? `${REPORT_URL}?refresh=1` : REPORT_URL,
      );
      if (!result.ok) {
        setLoadError(result.error);
        setReport(null);
        setLoading(false);
        return null;
      }
      setReport(result.data);
      setLoading(false);
      return result.data;
    },
    [],
  );

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  async function refreshReport() {
    const previous = report?.generatedAt;
    const next = await loadReport({ refresh: true });
    if (next && previous && next.generatedAt === previous) {
      toast({
        kind: "info",
        title: "Reverse DNS",
        description: "The last scan is under 15 seconds old, so it was shown again.",
      });
    }
  }

  async function refreshExternal() {
    if (externalBusy) return;
    setExternalBusy(true);
    try {
      const result = await mutate<{ ok: boolean; looked: number }>(EXTERNAL_REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!result.ok) {
        toast({
          kind: result.status === HTTP_TOO_MANY_REQUESTS ? "warn" : "error",
          title: "External lookups",
          description: result.error,
        });
        return;
      }
      toast({
        kind: "success",
        title: "External lookups",
        description: `Asked the world's resolvers about ${plural(result.data?.looked ?? 0, "address")}.`,
      });
      await loadReport();
    } finally {
      setExternalBusy(false);
    }
  }

  const rows = useMemo(() => report?.rows ?? [], [report]);
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (r) =>
          activeStatuses.has(r.status) && (horizonFilter === "all" || r.horizon === horizonFilter),
      ),
    [rows, activeStatuses, horizonFilter],
  );
  const allVisibleSelected = visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));
  const fixableRows = useMemo(
    () => rows.filter((r) => r.canWrite && FIXABLE_STATUSES.has(r.status)),
    [rows],
  );
  const horizonCounts = useMemo(() => {
    const counts: Record<HorizonFilter, number> = { all: rows.length, public: 0, internal: 0 };
    for (const r of rows) counts[r.horizon]++;
    return counts;
  }, [rows]);

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
      for (const r of visibleRows) {
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
   * followed by the lines of anything that was not simply written, then
   * `note` (what was skipped before sending, if anything).
   */
  async function rectify(items: readonly RectifyItem[], note = "") {
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
      const unchangedNote =
        summary.unchanged > 0 && summary.written === 0
          ? `${plural(summary.unchanged, "PTR")} already correct, left as is.`
          : "";
      toast({
        kind: summary.level === "error" ? "error" : summary.level === "warn" ? "warn" : "success",
        title: summary.level === "error" ? "Reverse DNS partly failed" : "Reverse DNS",
        description: [summary.text || unchangedNote || "Nothing needed changing.", detail, note]
          .filter(Boolean)
          .join(" "),
      });
    } finally {
      setBusy(false);
      setSelected(new Set());
      void loadReport();
    }
  }

  async function rectifySelected() {
    const selectedRows: PtrReconcileRow[] = [];
    for (const id of selected) {
      const row = rowById.get(id);
      if (row) selectedRows.push(row);
    }
    const plan = planSelection(selectedRows, picks);
    const note = skippedNote(plan);
    if (plan.items.length === 0) {
      toast({
        kind: "warn",
        title: "Nothing to rectify",
        description: note || "The selected rows have nothing to write.",
      });
      setSelected(new Set());
      return;
    }
    const alreadyCorrect = plan.alreadyCorrect
      ? ` ${plural(plan.alreadyCorrect, "address")} already correct: rewritten unchanged.`
      : "";
    const ok = await confirm({
      title: `Rectify ${plural(plan.items.length, "selected address")}?`,
      description: [confirmDescription(plan.items) + alreadyCorrect, note]
        .filter(Boolean)
        .join(" "),
      confirmLabel: "Rectify",
      variant: countActions(plan.items).removes > 0 ? "danger" : "default",
    });
    if (!ok) return;
    await rectify(plan.items, note);
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
          return (
            <span className="inline-flex items-center gap-2">
              <Checkbox
                checked={selected.has(r.id)}
                onChange={(on) => toggleSelected(r.id, on)}
                disabled={busy}
                ariaLabel={`Select ${r.ip}`}
              />
              <code className="font-mono text-sm break-all">{r.ip}</code>
            </span>
          );
        },
        meta: { className: "w-[16%]" },
      },
      {
        id: "forward",
        header: "Forward records",
        accessorFn: (r) => r.forward.map((f) => `${f.name} ${f.zone}`).join(" "),
        cell: ({ row }) => <ForwardCell row={row.original} />,
        meta: { className: "w-[24%]" },
      },
      {
        id: "currentPtr",
        header: "Current PTR",
        accessorFn: (r) =>
          [...r.currentTargets, ...(r.external?.targets ?? [])].join(" ") || r.external?.status,
        cell: ({ row }) => <CurrentPtrCell row={row.original} />,
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
        meta: { className: "w-[14%]" },
      },
      {
        accessorKey: "horizon",
        header: "Horizon",
        cell: ({ row }) => <HorizonChip horizon={row.original.horizon} />,
        meta: { className: "w-[8%]" },
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusChip status={row.original.status} />,
        sortingFn: (a, b) =>
          STATUS_ORDER.indexOf(a.original.status) - STATUS_ORDER.indexOf(b.original.status),
        meta: { className: "w-[9%]" },
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
        <SkeletonTable rows={8} cols={7} />
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
          , {plural(report.reverseZones.length, "hosted reverse zone")}. Scanned{" "}
          <LocalTime ts={report.generatedAt} style="relative" />.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void refreshExternal()}
            disabled={externalBusy || loading || busy || report.stats.unhosted === 0}
            title={
              report.stats.unhosted === 0
                ? "Every address is covered by a hosted reverse zone; there is nothing to look up upstream."
                : "Ask the world's resolvers now what PTR they answer for the addresses not hosted here. Otherwise lookups run in the background and spread over a few minutes."
            }
            className={TOOLBAR_BUTTON_CLASS}
          >
            <Globe className={`h-4 w-4 ${externalBusy ? "animate-pulse" : ""}`} aria-hidden />
            {externalBusy ? "Looking up…" : "Refresh external lookups"}
          </button>
          <button
            type="button"
            onClick={() => void refreshReport()}
            disabled={loading || busy}
            title="Re-read every zone. A scan younger than 15 seconds is shown again instead."
            className={TOOLBAR_BUTTON_CLASS}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden />
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
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

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
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
                className={`${FILTER_CHIP_CLASS} ${active ? CHIP_TONE_CLASS[tone] : INACTIVE_CHIP_CLASS}`}
              >
                {STATUS_LABEL[status]}
                <span className="tabular-nums">{report.stats[status]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by horizon">
          {HORIZON_FILTERS.map(({ value, label }) => {
            const active = horizonFilter === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                title={value === "all" ? "Rows from both horizons." : HORIZON_HINT[value]}
                onClick={() => setHorizonFilter(value)}
                className={`${FILTER_CHIP_CLASS} ${active ? CHIP_TONE_CLASS.accent : INACTIVE_CHIP_CLASS}`}
              >
                {label}
                <span className="tabular-nums">{horizonCounts[value]}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          checked={allVisibleSelected}
          onChange={toggleAllVisible}
          disabled={visibleRows.length === 0 || busy}
          label={
            <span className="text-sm">
              Select all {visibleRows.length} shown
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
            title="Writes or removes the PTR of every selected address. Already-correct rows are written unchanged; rows not hosted here are skipped."
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
        Ambiguous rows need a name picked and orphans need a decision; select those by hand. Any row
        can be selected: an OK row is rewritten unchanged, a row not hosted here is skipped.
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
            : "No rows match the selected statuses and horizon."
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

function HorizonChip({ horizon }: { horizon: ZoneHorizon }) {
  return (
    <span title={HORIZON_HINT[horizon]} className={HORIZON_BADGE_CLASS[horizon]}>
      {horizon}
      {/* The tooltip text, for keyboard and touch users who can't hover. */}
      <span className="sr-only"> ({HORIZON_HINT[horizon]})</span>
    </span>
  );
}

/** Tooltip for an external answer: who answered and when, plus the error if any. */
function externalTitle(external: ExternalPtr): string | undefined {
  const parts: string[] = [];
  if (external.error) parts.push(external.error);
  if (external.resolver) parts.push(`Answered by ${external.resolver}`);
  if (external.checkedAt) parts.push(`checked ${external.checkedAt}`);
  return parts.length ? parts.join("; ") : undefined;
}

/**
 * What the world answers for an address no hosted reverse zone covers. Colour
 * is never the only signal: the text names the state as well.
 */
function ExternalPtrCell({ external }: { external: ExternalPtr | undefined }) {
  const title = external ? externalTitle(external) : undefined;
  if (!external || external.status === "pending") {
    return (
      <span className="text-xs text-[color:var(--color-fg-muted)]" title={title}>
        world: {EXTERNAL_LABEL.pending}
      </span>
    );
  }
  if (external.status === "none" || external.status === "error") {
    return (
      <span className="text-xs text-[color:var(--color-fg-muted)]" title={title}>
        world: {EXTERNAL_LABEL[external.status]}
      </span>
    );
  }
  const tone =
    external.status === "match"
      ? "text-[color:var(--color-success-fg)]"
      : "text-[color:var(--color-warn-fg)]";
  return (
    <ul className="space-y-0.5" title={title}>
      {(external.targets ?? []).map((t) => (
        <li key={t} className={`font-mono text-xs break-all ${tone}`}>
          <span className="font-sans">world: </span>
          {t}
          {external.status === "mismatch" ? (
            <span className="font-sans text-[color:var(--color-fg-muted)]">
              {" "}
              (names another host)
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function CurrentPtrCell({ row }: { row: PtrReconcileRow }) {
  if (row.status === "unhosted") return <ExternalPtrCell external={row.external} />;
  if (row.currentTargets.length === 0) {
    return <span className="text-xs text-[color:var(--color-fg-muted)]">none</span>;
  }
  return (
    <ul className="space-y-0.5">
      {row.currentTargets.map((t) => (
        <li key={t} className="font-mono text-xs break-all">
          {t}
        </li>
      ))}
    </ul>
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

function externalSummary(external: ExternalPtr | undefined): string {
  if (!external || external.status === "pending") return EXTERNAL_LABEL.pending;
  if (external.status === "none") return EXTERNAL_LABEL.none;
  if (external.status === "error") return `${EXTERNAL_LABEL.error}: ${external.error ?? "unknown"}`;
  const targets = (external.targets ?? []).join(", ");
  return external.status === "match"
    ? `${targets} (names this host)`
    : `${targets} (names another host)`;
}

function RowDetail({ row }: { row: PtrReconcileRow }) {
  const names = forwardNames(row);
  return (
    <div className="space-y-2 pt-3 text-xs">
      <p>
        <StatusChip status={row.status} /> <HorizonChip horizon={row.horizon} />{" "}
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
        <dt className="text-[color:var(--color-fg-muted)]">Horizon</dt>
        <dd>
          {HORIZON_LABEL[row.horizon]}
          <span className="text-[color:var(--color-fg-muted)]"> - {HORIZON_HINT[row.horizon]}</span>
        </dd>
        <dt className="text-[color:var(--color-fg-muted)]">PTR owner</dt>
        <dd className="font-mono break-all">{row.owner}</dd>
        <dt className="text-[color:var(--color-fg-muted)]">Reverse zone</dt>
        <dd className="font-mono break-all">
          {row.reverseZone ? `${row.reverseZone} on ${row.reverseServer ?? "?"}` : "not hosted"}
        </dd>
        {row.status === "unhosted" ? (
          <>
            <dt className="text-[color:var(--color-fg-muted)]">World&apos;s PTR</dt>
            <dd className="font-mono break-all">
              {externalSummary(row.external)}
              {row.external && (row.external.resolver || row.external.checkedAt) ? (
                <span className="font-sans text-[color:var(--color-fg-muted)]">
                  {row.external.resolver ? ` via ${row.external.resolver}` : ""}
                  {row.external.checkedAt ? (
                    <>
                      , checked <LocalTime ts={row.external.checkedAt} style="relative" />
                    </>
                  ) : null}
                </span>
              ) : null}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-[color:var(--color-fg-muted)]">Current PTR</dt>
            <dd className="font-mono break-all">
              {row.currentTargets.length === 0
                ? "none"
                : `${row.currentTargets.join(", ")}${row.currentTtl !== null ? ` (TTL ${row.currentTtl})` : ""}`}
            </dd>
          </>
        )}
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
