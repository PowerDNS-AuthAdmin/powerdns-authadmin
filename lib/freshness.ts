/**
 * lib/pdns/freshness.ts
 *
 * Pure "time ago" formatter for the PDNS-server probe freshness
 * badge. Returns a short label and a discrete "kind" (fresh / aging
 * / stale) so the renderer can colour it without redoing the math.
 *
 * Computed server-side and passed to the client as a string prop, so
 * we never re-format on the client (avoids the
 * project-hydration-locale-dates trap where `Date.toLocaleString()`
 * client-side wipes the .dark class).
 */

export type FreshnessKind = "fresh" | "aging" | "stale";

export interface Freshness {
  label: string;
  kind: FreshnessKind;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * Thresholds match the `version_cache` TTL semantics elsewhere in
 * `lib/pdns/version.ts`. Anything older than 24h is "stale" and the
 * UI should encourage the operator to re-probe.
 */
const AGING_AFTER_MS = 1 * HOUR;
const STALE_AFTER_MS = 24 * HOUR;

export function freshnessOf(fetchedAtIso: string, now: number = Date.now()): Freshness {
  const fetchedAt = Date.parse(fetchedAtIso);
  if (Number.isNaN(fetchedAt)) {
    return { label: "unknown", kind: "stale" };
  }
  const ageMs = Math.max(0, now - fetchedAt);
  return { label: formatAge(ageMs), kind: classifyAge(ageMs) };
}

function classifyAge(ageMs: number): FreshnessKind {
  if (ageMs < AGING_AFTER_MS) return "fresh";
  if (ageMs < STALE_AFTER_MS) return "aging";
  return "stale";
}

function formatAge(ageMs: number): string {
  if (ageMs < MINUTE) return "just now";
  if (ageMs < HOUR) {
    const m = Math.floor(ageMs / MINUTE);
    return `${m}m ago`;
  }
  if (ageMs < DAY) {
    const h = Math.floor(ageMs / HOUR);
    return `${h}h ago`;
  }
  const d = Math.floor(ageMs / DAY);
  return `${d}d ago`;
}

/**
 * Day-resolution variant for dates we only know to the calendar day -
 * SOA-serial-derived "last edit", for example. The input is treated as
 * the start of a UTC day; we never claim sub-day precision because the
 * source can't carry it. Renders "today", "yesterday", or "Nd ago".
 *
 * Future-dated inputs render as "today" (clock skew shouldn't flip the
 * label to a negative day count).
 */
export function freshnessOfDay(iso: string, now: number = Date.now()): Freshness {
  const fetchedAt = Date.parse(iso);
  if (Number.isNaN(fetchedAt)) {
    return { label: "unknown", kind: "stale" };
  }
  const days = utcDayDelta(now, fetchedAt);
  let label: string;
  if (days <= 0) label = "today";
  else if (days === 1) label = "yesterday";
  else label = `${days}d ago`;
  // Reuse the hour-grained classifier so colour stays consistent: a
  // serial-derived "today" is fresh, "yesterday" is aging, and anything
  // older than a day is stale.
  const ageMs = Math.max(0, now - fetchedAt);
  return { label, kind: classifyAge(ageMs) };
}

function utcDayDelta(nowMs: number, thenMs: number): number {
  const nowDay = Math.floor(nowMs / DAY);
  const thenDay = Math.floor(thenMs / DAY);
  return nowDay - thenDay;
}
