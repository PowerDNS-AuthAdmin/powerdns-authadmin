"use client";

/**
 * app/(app)/zones/monitoring/_components/zone-monitor-panel.tsx
 *
 * The zone monitoring table: one row per hosted zone per backend, with the
 * verdict of the last background pass and the findings behind it.
 *
 * Reads `GET /api/admin/monitoring/zones` on mount. The monitor runs its
 * first pass a few seconds after boot, so an empty result set with no
 * completed cycle is polled every few seconds rather than shown as "no
 * zones". After that the state is re-read once a minute while the tab is
 * visible, so a cycle finishing in the background shows up without a reload.
 *
 * Writes go to `POST /api/admin/monitoring/zones/refresh`: an empty body
 * re-runs the fleet, `{ zone, serverSlug }` re-checks one zone. Both are
 * rate-limited server-side (the monitor probes other people's nameservers,
 * so a reload-happy tab must not turn into a flood); a 429 is surfaced as a
 * warning toast with the server's wording, not as an error.
 */

import { type ColumnDef } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FindingList,
  HorizonChip,
  ResultSummary,
  VERDICT_CHIP_CLASS,
  VerdictChip,
} from "@/components/domain/zone-monitor-findings";
import {
  awaitingFirstResults,
  compareResults,
  DELEGATION_HINT,
  DELEGATION_LABEL,
  formatInterval,
  plural,
  replaceResult,
  resultKey,
  summarizeFindings,
  VERDICT_HINT,
  VERDICT_LABEL,
  VERDICT_ORDER,
  verdictOf,
  type ZoneMonitorResult,
  type ZoneMonitorState,
  type ZoneVerdict,
} from "@/components/domain/zone-monitor-format";
import { DataTable } from "@/components/ui/data-table";
import { useDialog } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { SelectMenu } from "@/components/ui/select-menu";
import { SkeletonTable } from "@/components/ui/skeleton";
import { mutate } from "@/lib/client/api-fetch";

// ---------------------------------------------------------------- contract

const STATE_URL = "/api/admin/monitoring/zones";
const REFRESH_URL = "/api/admin/monitoring/zones/refresh";
const HTTP_TOO_MANY_REQUESTS = 429;
/** While the first cycle has not produced anything yet. */
const FIRST_RESULTS_POLL_MS = 10_000;
/** Background cycles finish without telling the tab; this keeps the page current. */
const BACKGROUND_REFRESH_MS = 60_000;

type HorizonFilter = "all" | "public" | "internal";

const HORIZON_OPTIONS: ReadonlyArray<{ value: HorizonFilter; label: string }> = [
  { value: "all", label: "All horizons" },
  { value: "public", label: "Public zones" },
  { value: "internal", label: "Internal zones" },
];

/** What is being checked right now: the whole fleet, one row (by its key), or nothing. */
type Busy = { kind: "all" } | { kind: "row"; key: string } | null;

const ALL_VERDICTS: ReadonlySet<ZoneVerdict> = new Set(VERDICT_ORDER);

const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded border border-[color:var(--color-border)] px-2 py-1 text-xs whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";
const TOOLBAR_BUTTON_CLASS =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-3 py-1.5 text-sm font-medium whitespace-nowrap hover:bg-[color:var(--color-bg-muted)] disabled:cursor-not-allowed disabled:opacity-50";
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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [liveMessage, setLiveMessage] = useState("");

  const loadState = useCallback(async (opts: { quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoading(true);
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
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  const waitingForFirst = state !== null && awaitingFirstResults(state);

  useEffect(() => {
    if (!waitingForFirst) return;
    const timer = setInterval(() => void loadState({ quiet: true }), FIRST_RESULTS_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingForFirst, loadState]);

  useEffect(() => {
    if (!state?.enabled || waitingForFirst) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && busy === null) {
        void loadState({ quiet: true });
      }
    }, BACKGROUND_REFRESH_MS);
    return () => clearInterval(timer);
  }, [state?.enabled, waitingForFirst, busy, loadState]);

  const toggleVerdict = useCallback((verdict: ZoneVerdict) => {
    setActiveVerdicts((cur) => {
      const next = new Set(cur);
      if (next.has(verdict)) next.delete(verdict);
      else next.add(verdict);
      return next;
    });
  }, []);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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
    async (row: ZoneMonitorResult) => {
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
          toast({
            kind: result.status === HTTP_TOO_MANY_REQUESTS ? "warn" : "error",
            title: result.status === HTTP_TOO_MANY_REQUESTS ? "Not yet" : "Re-check failed",
            description: result.error,
          });
          setLiveMessage("");
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

  const columns = useMemo<Array<ColumnDef<ZoneMonitorResult, unknown>>>(
    () => [
      {
        accessorKey: "zone",
        header: "Zone",
        cell: ({ row }) => (
          <Link
            href={zoneHref(row.original)}
            className="font-mono text-sm break-all text-[color:var(--color-accent)] hover:underline"
          >
            {row.original.zone}
          </Link>
        ),
      },
      {
        accessorKey: "server",
        header: "Backend",
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.server}</span>,
      },
      {
        accessorKey: "horizon",
        header: "Horizon",
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
          const isExpanded = expanded.has(key);
          return (
            <span className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void recheck(row.original)}
                disabled={busy !== null}
                aria-label={`Re-check ${row.original.zone} on ${row.original.server}`}
                className={BUTTON_CLASS}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`}
                  aria-hidden
                />
                {checking ? "Checking…" : "Re-check"}
              </button>
              <button
                type="button"
                onClick={() => toggleExpanded(key)}
                aria-expanded={isExpanded}
                aria-label={
                  isExpanded
                    ? `Hide details for ${row.original.zone}`
                    : `Show details for ${row.original.zone}`
                }
                className={BUTTON_CLASS}
              >
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                )}
                Details
              </button>
            </span>
          );
        },
      },
    ],
    [busy, expanded, recheck, toggleExpanded],
  );

  if (loading && !state) {
    return (
      <div className="space-y-3">
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-[color:var(--color-fg-muted)]"
        >
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden />
          Loading the latest results…
        </p>
        <SkeletonTable rows={8} cols={7} />
      </div>
    );
  }

  if (loadError && !state) {
    return (
      <div className="rounded-md border border-[color:var(--color-error)] bg-[color:var(--color-error)]/10 p-4 text-sm text-[color:var(--color-error-fg)]">
        <strong>Could not load the monitoring results.</strong> {loadError}
        <div className="mt-3">
          <button type="button" onClick={() => void loadState()} className={TOOLBAR_BUTTON_CLASS}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!state) return null;

  if (!state.enabled) {
    return (
      <div className={NOTICE_WARN_CLASS} role="status">
        <strong>Zone monitoring is disabled by ZONE_MONITOR_ENABLED.</strong> Set it to{" "}
        <code className="font-mono">true</code> and restart the app to check hosted zones on a
        schedule.
      </div>
    );
  }

  const checkingAll = busy?.kind === "all" || state.running;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-bg-subtle)] p-3 sm:flex-row sm:items-center sm:justify-between">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          <div className="flex gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Last run</dt>
            <dd>
              <LocalTime ts={state.lastCycleAt} style="relative" fallback="not yet" />
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Next run</dt>
            <dd>
              {checkingAll ? (
                <span className="inline-flex items-center gap-1">
                  <RefreshCw className="h-3 w-3 animate-spin" aria-hidden />
                  checking now
                </span>
              ) : (
                <LocalTime ts={state.nextCycleAt} style="relative" fallback="-" />
              )}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Interval</dt>
            <dd>{formatInterval(state.intervalMs)}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-[color:var(--color-fg-muted)]">Zones</dt>
            <dd className="tabular-nums">{state.counts.zones}</dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={busy !== null || state.running}
          className={TOOLBAR_BUTTON_CLASS}
        >
          <RefreshCw className={`h-4 w-4 ${checkingAll ? "animate-spin" : ""}`} aria-hidden />
          {busy?.kind === "all" ? "Running checks…" : "Run all checks now"}
        </button>
      </div>

      <p role="status" aria-live="polite" className={liveMessage ? "text-xs" : "sr-only"}>
        {liveMessage}
      </p>

      {state.offline ? (
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
          First check is running… Results appear here as soon as the first pass finishes.
        </p>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {VERDICT_ORDER.map((verdict) => {
            const active = activeVerdicts.has(verdict);
            return (
              <button
                key={verdict}
                type="button"
                aria-pressed={active}
                title={VERDICT_HINT[verdict]}
                onClick={() => toggleVerdict(verdict)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                  active
                    ? VERDICT_CHIP_CLASS[verdict]
                    : "border-[color:var(--color-border)] text-[color:var(--color-fg-muted)] opacity-70 hover:opacity-100"
                }`}
              >
                {VERDICT_LABEL[verdict]}
                <span className="tabular-nums">{state.counts[verdict]}</span>
              </button>
            );
          })}
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
        renderRowDetail={(row) =>
          expanded.has(resultKey(row)) ? <RowDetail result={row} /> : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------- detail

function RowDetail({ result }: { result: ZoneMonitorResult }) {
  return (
    <div className="grid gap-4 pt-3 lg:grid-cols-2">
      <section aria-label={`Findings for ${result.zone}`} className="space-y-2">
        <h3 className="text-xs font-semibold tracking-wide text-[color:var(--color-fg-muted)] uppercase">
          Findings
        </h3>
        <FindingList findings={result.findings} />
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
