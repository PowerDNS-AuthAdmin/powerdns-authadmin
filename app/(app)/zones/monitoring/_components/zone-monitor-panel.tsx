"use client";

/**
 * app/(app)/zones/monitoring/_components/zone-monitor-panel.tsx
 *
 * The zone monitoring table: one row per hosted zone per backend, with the
 * verdict of the last background pass and the findings behind it.
 *
 * Reads `GET /api/admin/monitoring/zones` after the shell has painted. The
 * monitor probes new zones within seconds of boot, so an empty result set is
 * polled every few seconds rather than shown as "no zones" until the first
 * row lands. After that the page stays current over the realtime bus: a
 * finished cycle, a zone edit or a health change nudges a debounced, quiet
 * re-fetch that keeps the rows on screen until the new ones arrive and leaves
 * the operator's filters and open row alone.
 *
 * Writes go to `POST /api/admin/monitoring/zones/refresh`: an empty body
 * re-runs the fleet, `{ zone, serverSlug }` re-checks one zone. Both are
 * rate-limited server-side (the monitor probes other people's nameservers,
 * so a reload-happy tab must not turn into a flood); a 429 is surfaced as a
 * warning toast with the server's wording, not as an error.
 *
 * A finding with a suggested fix gets a Fix button that opens a review
 * dialog; the save goes through the zone's own write route (see
 * ./soa-mname-fix-dialog.tsx) and the zone is re-checked afterwards so the
 * finding clears in place. When several zones share the SOA MNAME finding, a
 * banner offers "Review and fix all": one review of every zone, one Apply,
 * each zone saved through that same route (./soa-mname-bulk-fix-dialog.tsx),
 * then one re-check of the saved zones. `?fix=soa.mname` (the link on a
 * grouped notification) opens that review as soon as the results load.
 */

import { type ColumnDef } from "@tanstack/react-table";
import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  FindingList,
  HorizonChip,
  ResultSummary,
  VerdictChip,
} from "@/components/domain/zone-monitor-findings";
import {
  awaitingFirstResults,
  compareResults,
  DELEGATION_HINT,
  DELEGATION_LABEL,
  fixTargets,
  formatInterval,
  isNextRunDue,
  plural,
  replaceResult,
  resultKey,
  summarizeFindings,
  VERDICT_HINT,
  VERDICT_LABEL,
  VERDICT_ORDER,
  orderVerdictChips,
  verdictOf,
  type FixTarget,
  type ZoneFinding,
  type ZoneFindingFix,
  type ZoneMonitorResult,
  type ZoneMonitorState,
  type ZoneVerdict,
} from "@/components/domain/zone-monitor-format";
import { useRealtimeEvent } from "@/components/realtime/realtime-provider";
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
import { Skeleton, SkeletonTable } from "@/components/ui/skeleton";
import { ToggleChip, type ToggleChipTone } from "@/components/ui/toggle-chip";
import { mutate } from "@/lib/client/api-fetch";
import { SoaMnameBulkFixDialog } from "./soa-mname-bulk-fix-dialog";
import { SoaMnameFixDialog } from "./soa-mname-fix-dialog";

// ---------------------------------------------------------------- contract

const STATE_URL = "/api/admin/monitoring/zones";
const REFRESH_URL = "/api/admin/monitoring/zones/refresh";
const HTTP_TOO_MANY_REQUESTS = 429;
/** While no zone has been checked yet; realtime takes over once the first row exists. */
const FIRST_RESULTS_POLL_MS = 10_000;
/**
 * A cycle publishes one `monitor.updated` per backend and a zone edit publishes
 * `zone.updated` plus `health.updated`; one re-fetch per burst is enough.
 */
const REFETCH_DEBOUNCE_MS = 1500;

/** Events after which the results may have changed. */
function isMonitorEvent(event: { type: string }): boolean {
  return (
    event.type === "monitor.updated" ||
    event.type === "zone.updated" ||
    event.type === "health.updated" ||
    // the stream was reopened after a gap; anything may have changed meanwhile
    event.type === "realtime.reconnected"
  );
}

type HorizonFilter = "all" | "public" | "internal";

const HORIZON_OPTIONS: ReadonlyArray<{ value: HorizonFilter; label: string }> = [
  { value: "all", label: "All horizons" },
  { value: "public", label: "Public zones" },
  { value: "internal", label: "Internal zones" },
];

/** What is being checked right now: the whole fleet, one row (by its key), or nothing. */
type Busy = { kind: "all" } | { kind: "row"; key: string } | null;

const ALL_VERDICTS: ReadonlySet<ZoneVerdict> = new Set(VERDICT_ORDER);

/** Info is neutral on purpose; OK gets the success colour so it reads as a verdict, not an absence. */
const VERDICT_TONE: Record<ZoneVerdict, ToggleChipTone> = {
  error: "error",
  warn: "warn",
  info: "muted",
  ok: "success",
};

// The table only fits all nine columns from about 1600px. Below that, Horizon,
// Serial and Checked step out (delegation, serial and timing are also in each
// row's Observed panel), then Delegation below xl, so the table fits down to md
// instead of scrolling sideways.
const WIDE_ONLY = "hidden min-[1600px]:table-cell";
const WIDE_ONLY_HIDE = "min-[1600px]:hidden";

const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-2 py-1 text-xs whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";
const TOOLBAR_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5 text-sm font-medium whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";
/** The `?fix=` value that opens the bulk SOA MNAME review on load. */
const BULK_FIX_PARAM = "soa.mname";

const NOTICE_WARN_CLASS =
  "rounded-md border border-[color:var(--color-warn)] bg-[color:var(--color-warn)]/10 p-3 text-xs";

function zoneHref(result: ZoneMonitorResult): string {
  return `/zones/${encodeURIComponent(result.zone)}?server=${encodeURIComponent(result.server)}`;
}

// ---------------------------------------------------------------- component

export function ZoneMonitorPanel() {
  const { confirm, toast } = useDialog();
  const [state, setState] = useState<ZoneMonitorState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [activeVerdicts, setActiveVerdicts] = useState<ReadonlySet<ZoneVerdict>>(ALL_VERDICTS);
  const [horizon, setHorizon] = useState<HorizonFilter>("all");
  const details = useRowDisclosure();
  const panelPrefix = useId();
  const [liveMessage, setLiveMessage] = useState("");
  /** A quiet re-fetch is in flight: the rows on screen are kept until it lands. */
  const [updating, setUpdating] = useState(false);
  const [fixTarget, setFixTarget] = useState<{
    fix: ZoneFindingFix;
    result: ZoneMonitorResult;
  } | null>(null);
  /** The zones under bulk review; fixed when the dialog opens. */
  const [bulkFix, setBulkFix] = useState<FixTarget[] | null>(null);

  const loadState = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (opts.quiet) setUpdating(true);
    else setLoading(true);
    const result = await mutate<ZoneMonitorState>(STATE_URL);
    if (!result.ok) {
      // A background refresh that fails must not blank a page that was fine;
      // the next one will catch up.
      if (!opts.quiet) {
        setLoadError(result.error);
        setState(null);
      }
    } else {
      setLoadError(null);
      setState(result.data);
    }
    setUpdating(false);
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const waitingForFirst = state !== null && awaitingFirstResults(state);

  // The one remaining poll: until the first zone has been checked there is
  // nothing for the realtime bus to announce per row, and the first results
  // arrive within seconds of boot.
  useEffect(() => {
    if (!waitingForFirst) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void loadState({ quiet: true });
    }, FIRST_RESULTS_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingForFirst, loadState]);

  // Realtime: coalesce a burst of events into one quiet re-fetch. The timer
  // lives in a ref so an unmount mid-burst cancels it instead of fetching
  // into a component that is gone. A fleet run started from this tab already
  // replaces the state when it returns, so events during it are ignored.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useRealtimeEvent(isMonitorEvent, () => {
    if (busyRef.current?.kind === "all") return;
    setUpdating(true);
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = setTimeout(() => {
      refetchTimer.current = null;
      void loadState({ quiet: true });
    }, REFETCH_DEBOUNCE_MS);
  });
  useEffect(
    () => () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    },
    [],
  );

  const toggleVerdict = useCallback((verdict: ZoneVerdict) => {
    setActiveVerdicts((cur) => {
      const next = new Set(cur);
      if (next.has(verdict)) next.delete(verdict);
      else next.add(verdict);
      return next;
    });
  }, []);

  const runAll = useCallback(async () => {
    const ok = await confirm({
      title: "Run all checks now?",
      description:
        "Every hosted zone is probed again from this host: its nameservers, the parent delegation and the configured resolvers. This is allowed once a minute.",
      confirmLabel: "Run checks",
    });
    if (!ok) return;
    setBusy({ kind: "all" });
    setLiveMessage("Checking every zone…");
    try {
      const result = await mutate<ZoneMonitorState>(REFRESH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!result.ok) {
        toast({
          kind: result.status === HTTP_TOO_MANY_REQUESTS ? "warn" : "error",
          title: result.status === HTTP_TOO_MANY_REQUESTS ? "Not yet" : "Checks failed",
          description: result.error,
        });
        setLiveMessage("");
        return;
      }
      setState(result.data);
      setLiveMessage(`Checks finished for ${plural(result.data.counts.zones, "zone")}.`);
      toast({
        kind: "success",
        title: "Zone checks finished",
        description: `${plural(result.data.counts.zones, "zone")} checked: ${result.data.counts.error} with errors, ${result.data.counts.warn} with warnings.`,
      });
    } finally {
      setBusy(null);
    }
  }, [confirm, toast]);

  const recheck = useCallback(
    // `afterFix`: the re-check that follows an applied fix. The fix itself
    // succeeded, so a rate-limited re-check is not worth a warning; the next
    // cycle clears the finding anyway.
    async (row: ZoneMonitorResult, opts: { afterFix?: boolean } = {}) => {
      const key = resultKey(row);
      setBusy({ kind: "row", key });
      setLiveMessage(`Re-checking ${row.zone}…`);
      try {
        const result = await mutate<{ result: ZoneMonitorResult | null }>(REFRESH_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zone: row.zone, serverSlug: row.server }),
        });
        if (!result.ok) {
          setLiveMessage("");
          if (opts.afterFix && result.status === HTTP_TOO_MANY_REQUESTS) return;
          toast({
            kind: result.status === HTTP_TOO_MANY_REQUESTS ? "warn" : "error",
            title: result.status === HTTP_TOO_MANY_REQUESTS ? "Not yet" : "Re-check failed",
            description: result.error,
          });
          return;
        }
        const fresh = result.data.result;
        if (!fresh) {
          toast({
            kind: "warn",
            title: "Zone not checked",
            description: `${row.zone} is no longer hosted on ${row.server}; the list has been reloaded.`,
          });
          setLiveMessage("");
          void loadState({ quiet: true });
          return;
        }
        setState((cur) => (cur ? replaceResult(cur, fresh) : cur));
        setLiveMessage(
          `${row.zone} re-checked: ${VERDICT_LABEL[verdictOf(fresh)]}, ${plural(fresh.findings.length, "finding")}.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [toast, loadState],
  );

  const rows = useMemo(() => state?.results ?? [], [state]);
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (r) => activeVerdicts.has(verdictOf(r)) && (horizon === "all" || r.horizon === horizon),
      ),
    [rows, activeVerdicts, horizon],
  );
  const hasInternal = useMemo(() => rows.some((r) => r.horizon === "internal"), [rows]);
  const soaMnameTargets = useMemo(() => fixTargets(rows, "soa.mname"), [rows]);

  // A grouped notification links here with `?fix=soa.mname`: open its review
  // once, when the first results are in, and drop the parameter so a reload
  // or a later refresh does not open it again.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || state === null || waitingForFirst) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("fix") !== BULK_FIX_PARAM) return;
    autoOpened.current = true;
    url.searchParams.delete("fix");
    window.history.replaceState(window.history.state, "", url);
    if (soaMnameTargets.length > 0) setBulkFix(soaMnameTargets);
    else
      toast({
        kind: "success",
        title: "Nothing to fix",
        description: "No zone has the SOA MNAME finding any more.",
      });
  }, [state, waitingForFirst, soaMnameTargets, toast]);

  // The saved zones, re-checked in one pass. A refusal is not worth a
  // warning: the saves succeeded, and the next cycle clears the findings.
  const recheckFixed = useCallback(async (saved: readonly FixTarget[]) => {
    setLiveMessage(`Re-checking ${plural(saved.length, "zone")}…`);
    const result = await mutate<ZoneMonitorState>(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        zones: saved.map((t) => ({ zone: t.result.zone, serverSlug: t.result.server })),
      }),
    });
    if (result.ok) setState(result.data);
    setLiveMessage(result.ok ? `${plural(saved.length, "zone")} re-checked.` : "");
  }, []);

  const columns = useMemo<Array<ColumnDef<ZoneMonitorResult, unknown>>>(
    () => [
      {
        accessorKey: "zone",
        header: "Zone",
        // The other headers do not wrap, so in the auto layout this was the only
        // column left to give, and `break-all` let it shrink to one character.
        meta: { className: "min-w-[9rem]" },
        cell: ({ row }) => {
          const key = resultKey(row.original);
          // Chevron then the zone link on one line - also as the card title
          // under `md`, where a long zone name wraps but the chevron stays put.
          return (
            <span className="inline-flex max-w-full min-w-0 items-center gap-2">
              <DisclosureChevron
                open={details.isOpen(key)}
                onToggle={() => details.toggle(key)}
                label={`${row.original.zone} on ${row.original.server}`}
                controls={rowDetailId(panelPrefix, key)}
              />
              <Link
                href={zoneHref(row.original)}
                className="min-w-0 font-mono text-sm break-all text-[color:var(--color-accent)] hover:underline"
              >
                {row.original.zone}
              </Link>
            </span>
          );
        },
      },
      {
        accessorKey: "server",
        header: "Backend",
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            <span className="font-mono text-xs">{row.original.server}</span>
            {/* Stands in for the Horizon column while that one is hidden. */}
            <span className={`hidden md:inline-block ${WIDE_ONLY_HIDE}`}>
              <HorizonChip horizon={row.original.horizon} />
            </span>
          </span>
        ),
      },
      {
        accessorKey: "horizon",
        header: "Horizon",
        meta: { className: WIDE_ONLY },
        cell: ({ row }) => <HorizonChip horizon={row.original.horizon} />,
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (r) => VERDICT_LABEL[verdictOf(r)],
        sortingFn: (a, b) => compareResults(a.original, b.original),
        cell: ({ row }) => <VerdictChip verdict={verdictOf(row.original)} />,
      },
      {
        id: "findings",
        header: "Findings",
        accessorFn: (r) => r.findings.map((f) => `${f.code} ${f.title}`).join(" "),
        sortingFn: (a, b) => a.original.findings.length - b.original.findings.length,
        cell: ({ row }) => {
          const { count, headline } = summarizeFindings(row.original.findings);
          if (count === 0) {
            return <span className="text-xs text-[color:var(--color-fg-muted)]">none</span>;
          }
          return (
            <span className="block text-xs">
              <span className="tabular-nums">{plural(count, "finding")}</span>
              {headline ? (
                <span className="block text-[color:var(--color-fg-muted)]">{headline}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "delegation",
        header: "Delegation",
        accessorFn: (r) => DELEGATION_LABEL[r.summary.delegation],
        meta: { className: "hidden xl:table-cell" },
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap"
            title={DELEGATION_HINT[row.original.summary.delegation]}
          >
            {DELEGATION_LABEL[row.original.summary.delegation]}
          </span>
        ),
      },
      {
        id: "serial",
        header: "Serial",
        accessorFn: (r) => r.summary.serial ?? "",
        sortingFn: (a, b) => (a.original.summary.serial ?? -1) - (b.original.summary.serial ?? -1),
        meta: { className: WIDE_ONLY },
        cell: ({ row }) =>
          row.original.summary.serial === null ? (
            <span className="text-xs text-[color:var(--color-fg-muted)]">-</span>
          ) : (
            <span className="font-mono text-xs tabular-nums">{row.original.summary.serial}</span>
          ),
      },
      {
        accessorKey: "checkedAt",
        header: "Checked",
        meta: { className: WIDE_ONLY },
        cell: ({ row }) => (
          <LocalTime
            ts={row.original.checkedAt}
            style="relative"
            className="text-xs whitespace-nowrap text-[color:var(--color-fg-muted)]"
          />
        ),
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        cell: ({ row }) => {
          const key = resultKey(row.original);
          const checking = busy?.kind === "row" && busy.key === key;
          return (
            <button
              type="button"
              onClick={() => void recheck(row.original)}
              disabled={busy !== null}
              aria-label={`Re-check ${row.original.zone} on ${row.original.server}`}
              className={BUTTON_CLASS}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} aria-hidden />
              {checking ? "Checking…" : "Re-check"}
            </button>
          );
        },
      },
    ],
    [busy, details, panelPrefix, recheck],
  );

  if (state && !state.enabled) {
    return (
      <div className={NOTICE_WARN_CLASS} role="status">
        <strong>Zone monitoring is disabled by ZONE_MONITOR_ENABLED.</strong> Set it to{" "}
        <code className="font-mono">true</code> and restart the app to check hosted zones on a
        schedule.
      </div>
    );
  }

  const firstLoad = state === null;
  const checkingAll = busy?.kind === "all" || state?.running === true;

  // The shell (stats strip, chips, table frame) renders at once; only the
  // numbers and the rows wait for the first response.
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex items-center gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Last run</dt>
            <dd>
              {state ? (
                <LocalTime ts={state.lastCycleAt} style="relative" fallback="not yet" />
              ) : (
                <Skeleton className="h-3 w-16" />
              )}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Next run</dt>
            <dd>
              {!state ? (
                <Skeleton className="h-3 w-16" />
              ) : checkingAll ? (
                <span className="inline-flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                  checking now
                </span>
              ) : (
                <NextRun at={state.nextCycleAt} />
              )}
            </dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Interval</dt>
            <dd>{state ? formatInterval(state.intervalMs) : <Skeleton className="h-3 w-20" />}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Zones</dt>
            <dd className="tabular-nums">
              {state ? state.counts.zones : <Skeleton className="h-3 w-6" />}
            </dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={firstLoad || busy !== null || checkingAll}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <RefreshCw className={`h-4 w-4 ${checkingAll ? "animate-spin" : ""}`} aria-hidden />
          {busy?.kind === "all" ? "Running checks…" : "Run all checks now"}
        </button>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={
          liveMessage || updating || (loading && firstLoad)
            ? "flex flex-wrap items-center gap-x-1.5 text-xs text-[color:var(--color-fg-muted)]"
            : "sr-only"
        }
      >
        {liveMessage ? <span className="text-[color:var(--color-fg)]">{liveMessage}</span> : null}
        {loading && firstLoad ? (
          <span className="inline-flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
            Loading the latest results…
          </span>
        ) : updating ? (
          <span className="inline-flex items-center gap-1">
            <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
            updating…
          </span>
        ) : null}
      </p>

      {loadError && !state ? (
        <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error-fg)]">
          <strong>Could not load the monitoring results.</strong> {loadError}
          <div className="mt-3">
            <button type="button" onClick={() => void loadState()} className={TOOLBAR_BUTTON_CLASS}>
              <RefreshCw className="h-4 w-4" aria-hidden />
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {state?.offline ? (
        <div className={NOTICE_WARN_CLASS} role="status">
          <strong>Offline: no path to the root servers.</strong> Delegation and DNSSEC chain checks
          for public zones were skipped this cycle and show as unverified. Nameserver and resolver
          checks still ran.
        </div>
      ) : null}

      {waitingForFirst ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-[color:var(--color-fg-muted)]"
        >
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          First checks are running; results appear here as each zone is checked.
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {/* Ordered by count, so until the first state lands they are
              placeholders rather than chips that jump into place. */}
          {!state &&
            VERDICT_ORDER.map((verdict) => (
              <Skeleton
                key={verdict}
                className="h-[1.625rem] w-20 rounded-full"
                label="Counting…"
              />
            ))}
          {state &&
            orderVerdictChips(state.counts).map((verdict) => (
              <ToggleChip
                key={verdict}
                active={activeVerdicts.has(verdict)}
                tone={VERDICT_TONE[verdict]}
                title={VERDICT_HINT[verdict]}
                onClick={() => toggleVerdict(verdict)}
                count={state.counts[verdict]}
              >
                {VERDICT_LABEL[verdict]}
              </ToggleChip>
            ))}
        </div>
        {hasInternal ? (
          <SelectMenu
            value={horizon}
            options={HORIZON_OPTIONS}
            onChange={setHorizon}
            ariaLabel="Filter by horizon"
            className="text-xs sm:w-44"
          />
        ) : null}
      </div>

      {soaMnameTargets.length > 1 ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 text-xs sm:flex-row sm:items-center sm:justify-between"
          role="status"
        >
          <span>
            <strong>{plural(soaMnameTargets.length, "zone")}</strong> have an SOA MNAME that is not
            one of their nameservers, each with a suggested primary.
          </span>
          <button
            type="button"
            onClick={() => setBulkFix(soaMnameTargets)}
            disabled={busy !== null}
            className={TOOLBAR_BUTTON_CLASS}
          >
            Review and fix all
          </button>
        </div>
      ) : null}

      {firstLoad ? (
        loadError ? null : (
          <SkeletonTable rows={8} cols={7} />
        )
      ) : (
        <DataTable
          columns={columns}
          data={visibleRows}
          searchPlaceholder="Search by zone, backend or finding…"
          searchShortcut
          pageSize={25}
          initialSort={[{ id: "status", desc: false }]}
          stateKey="zone-monitoring"
          noDataMessage={
            rows.length === 0
              ? waitingForFirst
                ? "Waiting for the first results."
                : "No hosted zones to check."
              : "No zones match the selected filters."
          }
          renderRowDetail={(row) => {
            const key = resultKey(row);
            return details.isOpen(key) ? (
              <RowDisclosurePanel
                id={rowDetailId(panelPrefix, key)}
                label={`Details for ${row.zone} on ${row.server}`}
              >
                <RowDetail
                  result={row}
                  onFix={(finding) => {
                    if (finding.fix) setFixTarget({ fix: finding.fix, result: row });
                  }}
                />
              </RowDisclosurePanel>
            ) : null;
          }}
        />
      )}
      {fixTarget?.fix.kind === "soa.mname" ? (
        <SoaMnameFixDialog
          fix={fixTarget.fix}
          serverSlug={fixTarget.result.server}
          onClose={() => setFixTarget(null)}
          onApplied={() => void recheck(fixTarget.result, { afterFix: true })}
        />
      ) : null}
      {bulkFix ? (
        <SoaMnameBulkFixDialog
          targets={bulkFix}
          onClose={() => setBulkFix(null)}
          onApplied={(saved) => void recheckFixed(saved)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- detail

function RowDetail({
  result,
  onFix,
}: {
  result: ZoneMonitorResult;
  onFix: (finding: ZoneFinding) => void;
}) {
  return (
    <div className="grid gap-4 pt-3 lg:grid-cols-2">
      <section aria-label={`Findings for ${result.zone}`} className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Findings
        </h3>
        <FindingList
          findings={result.findings}
          renderFixAction={(finding) => (
            <button
              type="button"
              className={BUTTON_CLASS}
              onClick={() => onFix(finding)}
              aria-label={`Fix: ${finding.title} (${result.zone})`}
            >
              Fix
            </button>
          )}
        />
      </section>
      <section aria-label={`Observations for ${result.zone}`} className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Observed
        </h3>
        <ResultSummary result={result} />
      </section>
    </div>
  );
}

/** The next scheduled run, re-checked every few seconds so it never counts into the past. */
function NextRun({ at }: { at: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  if (isNextRunDue(at, now)) return <span>due now</span>;
  return <LocalTime ts={at} style="relative" fallback="-" />;
}
