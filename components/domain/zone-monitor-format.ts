/**
 * components/domain/zone-monitor-format.ts
 *
 * Pure vocabulary and formatting for the Zone Monitoring page: the API shape
 * as the browser sees it, the severity ordering, human labels for the
 * delegation verdicts, interval/duration text, the apex-vs-parent NS
 * comparison the detail panel highlights, and the in-place update applied
 * after a single-zone re-check.
 *
 * Kept free of React so the rules are unit-testable and the client component
 * only renders. The types mirror `lib/monitoring/zone-monitor.ts` through
 * type-only imports: no runtime code from the server-only module is pulled
 * into the client bundle, but a shape change there fails typecheck here.
 */

import type { FindingSeverity, ZoneFinding, ZoneFindingFix } from "@/lib/dns/zone-checks";
import type { ZoneMonitorResult, ZoneMonitorState } from "@/lib/monitoring/zone-monitor";
import { orderChipsByCount } from "./chip-order";

export type { FindingSeverity, ZoneFinding, ZoneFindingFix, ZoneMonitorResult, ZoneMonitorState };

/** A row's verdict: a finding severity, or `ok` when the zone had no findings. */
export type ZoneVerdict = FindingSeverity | "ok";

export type DelegationStatus = ZoneMonitorResult["summary"]["delegation"];

/** Worst first; the default sort and the chip order. */
export const VERDICT_ORDER: readonly ZoneVerdict[] = ["error", "warn", "info", "ok"];

/**
 * The verdict chips, ordered like the Reverse DNS status chips: biggest count
 * first, empty verdicts last. Info (nothing to act on) never jumps ahead of
 * errors, warnings or OK.
 */
export function orderVerdictChips(counts: Readonly<Record<ZoneVerdict, number>>): ZoneVerdict[] {
  return orderChipsByCount(
    { order: VERDICT_ORDER, passive: "info", passiveAfter: new Set(["error", "warn", "ok"]) },
    counts,
  );
}

export const VERDICT_LABEL: Record<ZoneVerdict, string> = {
  error: "Error",
  warn: "Warning",
  info: "Info",
  ok: "OK",
};

export const VERDICT_HINT: Record<ZoneVerdict, string> = {
  error: "Resolvers are failing, or will soon fail, to answer for the zone.",
  warn: "The zone works but is fragile or inconsistent.",
  info: "Worth knowing; nothing to fix today.",
  ok: "Every check passed.",
};

export const DELEGATION_LABEL: Record<DelegationStatus, string> = {
  delegated: "delegated",
  "not-delegated": "not delegated",
  unreachable: "unverified",
  "served-by-parent": "served by parent",
  skipped: "skipped",
};

export const DELEGATION_HINT: Record<DelegationStatus, string> = {
  delegated: "The parent zone delegates to nameservers; compared with the apex NS set.",
  "not-delegated": "The parent zone has no delegation for this zone.",
  unreachable: "The walk from the root servers failed, so the delegation could not be checked.",
  "served-by-parent": "The parent's nameservers answer authoritatively for the zone themselves.",
  skipped: "Internal zones are not looked up at the parent.",
};

export function verdictOf(result: Pick<ZoneMonitorResult, "severity">): ZoneVerdict {
  return result.severity ?? "ok";
}

/** 0 for the worst verdict; sorts rows and findings worst first. */
export function verdictRank(verdict: ZoneVerdict): number {
  return VERDICT_ORDER.indexOf(verdict);
}

/** Worst verdict first, then by zone name so equal rows keep a stable order. */
export function compareResults(a: ZoneMonitorResult, b: ZoneMonitorResult): number {
  return (
    verdictRank(verdictOf(a)) - verdictRank(verdictOf(b)) ||
    a.zone.localeCompare(b.zone) ||
    a.server.localeCompare(b.server)
  );
}

/** Stable identity of a result: a zone can exist on several backends. */
export function resultKey(result: Pick<ZoneMonitorResult, "zone" | "server">): string {
  return `${result.server}|${result.zone}`;
}

/** "1 zone", "3 zones", "3 addresses": sibilant endings take "es". */
export function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  const suffix = /(s|x|z|ch|sh)$/i.test(word) ? "es" : "s";
  return `${n} ${word}${suffix}`;
}

/** One-line text for a finding's suggested fix, shown under the finding. */
export function describeFix(fix: ZoneFindingFix): string {
  switch (fix.kind) {
    case "soa.mname":
      return `Suggested fix: set the SOA MNAME to ${fix.suggested}`;
  }
}

/**
 * The SOA content with only its first field (MNAME) replaced. RNAME, serial
 * and timers are kept as they are; PowerDNS bumps the serial itself on the
 * write (SOA-EDIT-API).
 */
export function withSoaMname(content: string, mname: string): string {
  const fields = content.trim().split(/\s+/);
  if (fields.length < 2) return content;
  fields[0] = mname;
  return fields.join(" ");
}

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * "every 15 minutes", "every 90 seconds", "every 2 hours". Whole units only:
 * the interval comes from an env var and operators type round numbers.
 */
export function formatInterval(ms: number): string {
  if (ms >= HOUR_MS && ms % HOUR_MS === 0) return `every ${plural(ms / HOUR_MS, "hour")}`;
  if (ms >= MINUTE_MS && ms % MINUTE_MS === 0) return `every ${plural(ms / MINUTE_MS, "minute")}`;
  return `every ${plural(Math.round(ms / SECOND_MS), "second")}`;
}

/**
 * True once the scheduled run's moment has passed. The header then says "due
 * now" rather than counting into the past, which reads like a stuck scheduler;
 * the run starts within moments, or is queued behind a partial check.
 */
export function isNextRunDue(nextCycleAt: string | null, now: number): boolean {
  if (!nextCycleAt) return false;
  const at = Date.parse(nextCycleAt);
  return Number.isFinite(at) && at <= now;
}

/** Probe duration: sub-second in ms, otherwise one decimal of seconds. */
export function formatDuration(ms: number): string {
  if (ms < SECOND_MS) return `${Math.round(ms)} ms`;
  return `${(ms / SECOND_MS).toFixed(1)} s`;
}

/** "3 findings" plus the worst finding's title, for the table cell. */
export function summarizeFindings(findings: readonly ZoneFinding[]): {
  count: number;
  headline: string | null;
} {
  if (findings.length === 0) return { count: 0, headline: null };
  const worst = [...findings].sort((a, b) => verdictRank(a.severity) - verdictRank(b.severity))[0]!;
  return { count: findings.length, headline: worst.title };
}

export interface NameserverSetEntry {
  name: string;
  inApex: boolean;
  inParent: boolean;
}

/**
 * Union of the apex and parent NS sets, lower-cased and sorted, flagged on
 * each side. A name missing from one side is what the detail panel
 * highlights; trailing-dot and case differences are not differences.
 */
export function compareNameserverSets(
  apex: readonly string[],
  parent: readonly string[],
): NameserverSetEntry[] {
  const canonical = (name: string): string => {
    const lower = name.trim().toLowerCase();
    return lower.endsWith(".") ? lower : `${lower}.`;
  };
  const apexSet = new Set(apex.map(canonical));
  const parentSet = new Set(parent.map(canonical));
  return [...new Set([...apexSet, ...parentSet])].sort().map((name) => ({
    name,
    inApex: apexSet.has(name),
    inParent: parentSet.has(name),
  }));
}

/** Verdict tallies for a list of results, in the API's `counts` shape. */
export function countVerdicts(results: readonly ZoneMonitorResult[]): ZoneMonitorState["counts"] {
  const counts = { zones: results.length, error: 0, warn: 0, info: 0, ok: 0 };
  for (const r of results) counts[verdictOf(r)]++;
  return counts;
}

/**
 * The state after one zone was re-checked: that row replaced (or appended
 * when it was new), counts recomputed, everything else untouched. The full
 * cycle's timestamps are deliberately left alone; a single re-check is not
 * a cycle.
 */
export function replaceResult(
  state: ZoneMonitorState,
  result: ZoneMonitorResult,
): ZoneMonitorState {
  const key = resultKey(result);
  let replaced = false;
  const results = state.results.map((r) => {
    if (resultKey(r) !== key) return r;
    replaced = true;
    return result;
  });
  if (!replaced) results.push(result);
  results.sort(compareResults);
  return { ...state, results, counts: countVerdicts(results) };
}

/**
 * Whether the page should keep polling for the first results: monitoring is
 * on and no zone has been checked yet. The monitor probes new zones within
 * seconds, so an empty list means "not yet", not "no zones" - and until a row
 * exists there is nothing for the realtime bus to announce per row.
 */
export function awaitingFirstResults(state: ZoneMonitorState): boolean {
  return state.enabled && state.results.length === 0;
}
