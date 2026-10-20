"use client";

/**
 * app/(app)/zones/auto-ptr/_components/ptr-reconciler.tsx
 *
 * The reverse DNS reconciler: one row per address found in an A/AAAA record
 * anywhere in the fleet, compared with the PTR that exists for it today.
 *
 * Fetches `GET /api/admin/pdns/auto-ptr/report` after the shell has painted
 * (the first scan reads every zone, so the stats strip and skeleton rows show
 * first) and rectifies through `POST /api/admin/pdns/auto-ptr/rectify`, which
 * runs the same planner, the same permission checks and the same audit rows
 * as the record editor's auto-PTR. The outcomes come back in the editor's
 * `AutoPtrOutcome` shape so the toast reads identically in both places.
 *
 * After the first load the page stays current over the realtime bus: a zone
 * edit, a health change, a finished fleet scan or an external lookup nudges a
 * debounced re-fetch. The report route serves an incremental scan, so that
 * re-fetch is cheap, and it is quiet: the rows already on screen stay until
 * the new ones arrive, and the operator's filters, selection and open row are
 * left alone.
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
import { Earth, Globe, Plus, RefreshCw, Trash2, Wand2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import {
  DisclosureChevron,
  RowDisclosurePanel,
  rowDetailId,
  useRowDisclosure,
} from "@/components/ui/row-disclosure";
import { SelectMenu } from "@/components/ui/select-menu";
import { SkeletonTable } from "@/components/ui/skeleton";
import { ToggleChip, type ToggleChipTone } from "@/components/ui/toggle-chip";
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
/**
 * Realtime events arrive in bursts (a zone edit publishes `zone.updated` and
 * `health.updated`; a scan publishes once per backend); one re-fetch per
 * burst is enough.
 */
const REFETCH_DEBOUNCE_MS = 1500;
/** The external-PTR lookup used the host's own resolver rather than a configured one. */
const SYSTEM_RESOLVER = "system";

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

/** OK is a verdict, not an absence: it gets the success colour so it reads as a state the operator chose to see. */
function statusTone(status: PtrStatus): ToggleChipTone {
  if (status === "orphan") return "error";
  if (ATTENTION_STATUSES.has(status)) return "warn";
  if (status === "ok") return "success";
  return "muted";
}

/** The read-only chip in the Status column and the detail panel. */
const CHIP_TONE_CLASS: Record<ToggleChipTone, string> = {
  warn: "border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 text-[color:var(--color-warn-fg)]",
  error:
    "border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 text-[color:var(--color-error-fg)]",
  success:
    "border-[color:var(--color-success)] bg-[color:var(--color-success)]/10 text-[color:var(--color-success-fg)]",
  muted: "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)]",
  accent:
    "border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]",
};

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

/** Whose answer the earth icon stands for; the resolver address when the lookup names one. */
function externalViewpoint(horizon: ZoneHorizon, external: ExternalPtr | undefined): string {
  if (external?.resolver === SYSTEM_RESOLVER) return "This is what this server's resolver sees";
  const base =
    horizon === "public"
      ? "This is what the public resolvers see"
      : "This is what the internal resolvers see";
  return external?.resolver ? `${base} (via ${external.resolver})` : base;
}

/** The resolver as the detail panel names it; the host's own resolver has no address to show. */
function externalResolverLabel(resolver: string): string {
  return resolver === SYSTEM_RESOLVER ? "this server's resolver" : resolver;
}

/** Events after which the report may have changed: zone edits, health moves, scans and lookups. */
function isReportEvent(event: { type: string }): boolean {
  return (
    event.type === "monitor.updated" ||
    event.type === "zone.updated" ||
    event.type === "health.updated" ||
    // the stream was reopened after a gap; anything may have changed meanwhile
    event.type === "realtime.reconnected"
  );
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
  const details = useRowDisclosure();
  const panelPrefix = useId();
  /** A quiet re-fetch is in flight: the rows on screen are kept until it lands. */
  const [updating, setUpdating] = useState(false);
  /** The last quiet re-fetch failed; the rows on screen are from the previous one. */
  const [updateError, setUpdateError] = useState<string | null>(null);

  /**
   * Load the report. `refresh` asks the server for a fresh scan, which it
   * grants at most once per 15 s and otherwise answers with the cached one.
   * `quiet` keeps the current report (and the table under it) in place while
   * the request runs and never blanks the page on failure; it is what the
   * realtime nudges and the post-rectify reload use. Returns the report so
   * the caller can tell which it got.
   */
  const loadReport = useCallback(
    async (
      opts: { refresh?: boolean; quiet?: boolean } = {},
    ): Promise<PtrReconcileReport | null> => {
      if (opts.quiet) setUpdating(true);
      else {
        setLoading(true);
        setLoadError(null);
      }
      const result = await mutate<PtrReconcileReport>(
        opts.refresh ? `${REPORT_URL}?refresh=1` : REPORT_URL,
      );
      if (!result.ok) {
        if (opts.quiet) {
          setUpdateError(result.error);
          setUpdating(false);
        } else {
          setLoadError(result.error);
          setReport(null);
          setLoading(false);
        }
        return null;
      }
      setReport(result.data);
      setUpdateError(null);
      setUpdating(false);
      setLoading(false);
      return result.data;
    },
    [],
  );

  useEffect(() => {
    void loadReport();
  }, [loadReport]);

  // Realtime: coalesce a burst of events into one quiet re-fetch. The timer
  // lives in a ref so an unmount mid-burst cancels it instead of fetching
  // into a component that is gone.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtimeEvent(isReportEvent, () => {
    setUpdating(true);
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void loadReport({ quiet: true });
    }, REFETCH_DEBOUNCE_MS);
  });
  useEffect(
    () => () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    },
    [],
  );

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
      void loadReport({ quiet: true });
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
          // Chevron, checkbox, address on one line - also as the card title
          // under `md`, where the address may wrap but the controls stay put.
          return (
            <span className="inline-flex max-w-full min-w-0 items-center gap-2">
              <DisclosureChevron
                open={details.isOpen(r.id)}
                onToggle={() => details.toggle(r.id)}
                label={r.ip}
                controls={rowDetailId(panelPrefix, r.id)}
              />
              <Checkbox
                checked={selected.has(r.id)}
                onChange={(on) => toggleSelected(r.id, on)}
                disabled={busy}
                ariaLabel={`Select ${r.ip}`}
              />
              <code className="min-w-0 font-mono text-sm break-all">{r.ip}</code>
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
            onPick={(name) => setPicks((cur) => ({ ...cur, [row.original.id]: name }))}
            onRectify={() => void rectifyRow(row.original)}
          />
        ),
      },
    ],
    // The cells close over selection, picks and the open row so the memo must
    // follow them; rectifyRow is stable enough in practice because the row
    // it needs is passed in.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, picks, details, busy, panelPrefix],
  );

  const selectedCount = [...selected].filter((id) => rowById.has(id)).length;
  const stats = report?.stats ?? null;
  const firstLoad = report === null;

  // The shell (status line, toolbar, chips, selection bar) renders at once;
  // only the numbers and the rows wait for the report.
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-[color:var(--color-fg-muted)]">
          {report ? (
            <span>
              {plural(report.stats.recordsScanned, "address record")} across{" "}
              {plural(report.stats.zonesScanned, "zone")} on{" "}
              {plural(report.backends.length, "backend")},{" "}
              {plural(report.reverseZones.length, "hosted reverse zone")}. Scanned{" "}
              <LocalTime ts={report.generatedAt} style="relative" />.
            </span>
          ) : loadError ? null : (
            <span className="inline-flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Reading every zone on every backend. On a large installation this takes a while.
            </span>
          )}
          {/* Only the live-update note is announced; the relative "scanned …"
              text above re-renders every minute and would be noise. */}
          <span role="status" aria-live="polite" className="inline-flex items-center gap-1">
            {updating ? (
              <>
                <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                updating…
              </>
            ) : updateError ? (
              <span className="text-[color:var(--color-warn-fg)]">
                Live update failed ({updateError}); showing the previous scan.
              </span>
            ) : null}
          </span>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button
            type="button"
            onClick={() => void refreshExternal()}
            disabled={externalBusy || loading || busy || !stats || stats.unhosted === 0}
            title={
              stats?.unhosted === 0
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

      {loadError && !report ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error-fg)]">
          <strong>Could not build the report.</strong> {loadError}
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void loadReport()}
              className={TOOLBAR_BUTTON_CLASS}
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {report && report.errors.length > 0 ? (
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
          {STATUS_ORDER.map((status) => (
            <ToggleChip
              key={status}
              active={activeStatuses.has(status)}
              tone={statusTone(status)}
              title={STATUS_HINT[status]}
              onClick={() => toggleStatus(status)}
              count={stats ? stats[status] : null}
            >
              {STATUS_LABEL[status]}
            </ToggleChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by horizon">
          {HORIZON_FILTERS.map(({ value, label }) => (
            <ToggleChip
              key={value}
              active={horizonFilter === value}
              tone="accent"
              title={value === "all" ? "Rows from both horizons." : HORIZON_HINT[value]}
              onClick={() => setHorizonFilter(value)}
              count={report ? horizonCounts[value] : null}
            >
              {label}
            </ToggleChip>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <Checkbox
          checked={allVisibleSelected}
          onChange={toggleAllVisible}
          disabled={visibleRows.length === 0 || busy || firstLoad}
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

      {firstLoad ? (
        loadError ? null : (
          <SkeletonTable rows={8} cols={7} />
        )
      ) : (
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
          renderRowDetail={(row) =>
            details.isOpen(row.id) ? (
              <RowDisclosurePanel
                id={rowDetailId(panelPrefix, row.id)}
                label={`Details for ${row.ip}`}
              >
                <RowDetail row={row} />
              </RowDisclosurePanel>
            ) : null
          }
        />
      )}
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
 * The earth icon in front of an external answer: whose view this is. It is
 * the only thing in the cell that says "upstream", so it carries the
 * explanation as its accessible name and tooltip.
 */
function ExternalViewpointIcon({ title }: { title: string }) {
  return (
    <span title={title} className="inline-flex shrink-0">
      <Earth role="img" aria-label={title} className="h-3.5 w-3.5" />
    </span>
  );
}

/**
 * What the upstream resolvers answer for an address no hosted reverse zone
 * covers. Colour is never the only signal: the text names the state as well.
 */
function ExternalPtrCell({ row }: { row: PtrReconcileRow }) {
  const external = row.external;
  const title = external ? externalTitle(external) : undefined;
  const viewpoint = externalViewpoint(row.horizon, external);
  if (!external || external.status === "pending") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-[color:var(--color-fg-muted)]"
        title={title}
      >
        <ExternalViewpointIcon title={viewpoint} />
        {EXTERNAL_LABEL.pending}
      </span>
    );
  }
  if (external.status === "none" || external.status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-[color:var(--color-fg-muted)]"
        title={title}
      >
        <ExternalViewpointIcon title={viewpoint} />
        {EXTERNAL_LABEL[external.status]}
      </span>
    );
  }
  const tone =
    external.status === "match"
      ? "text-[color:var(--color-success-fg)]"
      : "text-[color:var(--color-warn-fg)]";
  return (
    <span className={`flex items-start gap-1 ${tone}`} title={title}>
      <span className="mt-px inline-flex">
        <ExternalViewpointIcon title={viewpoint} />
      </span>
      <ul className="min-w-0 space-y-0.5">
        {(external.targets ?? []).map((t) => (
          <li key={t} className="font-mono text-xs break-all">
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
    </span>
  );
}

function CurrentPtrCell({ row }: { row: PtrReconcileRow }) {
  if (row.status === "unhosted") return <ExternalPtrCell row={row} />;
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

/**
 * An orphan PTR names a host that has no A/AAAA record: the quickest fix is to
 * add that record, so the empty cell carries a shortcut into the Add record
 * wizard with the name, type and address prefilled (the wizard asks for the
 * zone, since the PTR target alone does not say which hosted zone it belongs to).
 */
function addForwardHref(row: PtrReconcileRow): string | null {
  const target = row.currentTargets[0];
  if (!target) return null;
  const params = new URLSearchParams({
    name: target,
    type: row.family === 4 ? "A" : "AAAA",
    content: row.ip,
  });
  return `/zones/new-record?${params.toString()}`;
}

function ForwardCell({ row }: { row: PtrReconcileRow }) {
  if (row.forward.length === 0) {
    const href = row.status === "orphan" ? addForwardHref(row) : null;
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="text-xs text-[color:var(--color-fg-muted)]">none</span>
        {href ? (
          <Link
            href={href}
            className="inline-flex items-center gap-1 rounded-md border border-[color:var(--color-border)] px-1.5 py-0.5 text-xs font-medium text-[color:var(--color-accent)] hover:bg-[color:var(--color-bg-subtle)] focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:outline-none"
            title={`Add an ${row.family === 4 ? "A" : "AAAA"} record for ${row.currentTargets[0]} pointing at ${row.ip}`}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            Add
          </Link>
        ) : null}
      </span>
    );
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
  onPick,
  onRectify,
}: {
  row: PtrReconcileRow;
  pick: string | undefined;
  busy: boolean;
  onPick: (name: string) => void;
  onRectify: () => void;
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
  if (action === null) return null;
  return <span className="flex flex-wrap items-center gap-2">{action}</span>;
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
            <dt className="text-[color:var(--color-fg-muted)]">Upstream PTR</dt>
            <dd className="font-mono break-all">
              {externalSummary(row.external)}
              {row.external && (row.external.resolver || row.external.checkedAt) ? (
                <span className="font-sans text-[color:var(--color-fg-muted)]">
                  {row.external.resolver
                    ? ` via ${externalResolverLabel(row.external.resolver)}`
                    : ""}
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
