"use client";

/**
 * `<LocalTime>` — render a UTC ISO timestamp in the browser's local
 * timezone. Server data stays UTC end-to-end (canonical, comparable,
 * portable); only the rendered text is converted.
 *
 * Hydration: the server has no `Intl` zone access for the operator's
 * browser, so the first render (both server and client) produces a
 * stable UTC string. Once mounted on the client, we re-render in the
 * user's local zone. This produces the SAME output on both sides of
 * hydration — no `suppressHydrationWarning` needed, and no
 * "server-text-stays-frozen" trap (which previously kept timestamps
 * in UTC and made the picker look 8 hours out of sync with the
 * table).
 *
 * Variants via `style`:
 *   • "datetime" (default) — "2026-05-18 13:45:21" in local zone
 *   • "date"               — "2026-05-18"
 *   • "time"               — "13:45:21"
 *   • "iso"                — local zone ISO (`YYYY-MM-DDTHH:mm:ss±HH:MM`)
 *   • "relative"           — "2 minutes ago" / "in 3 hours"
 */

import { useEffect, useState } from "react";

type LocalTimeStyle = "datetime" | "date" | "time" | "iso" | "relative";

interface Props {
  /** Either an ISO 8601 string or a Date — both interpreted as UTC by spec. */
  ts: string | Date | null | undefined;
  /** Rendering variant. Default `datetime`. */
  style?: LocalTimeStyle;
  /** Tooltip override. Defaults to the canonical UTC ISO for traceability. */
  title?: string;
  /** Optional className passthrough. */
  className?: string;
  /** When the input is null/empty/unparseable, render this string. */
  fallback?: string;
}

export function LocalTime({ ts, style = "datetime", title, className, fallback = "—" }: Props) {
  // `mounted` flips true after first client paint. Before that we
  // render a UTC string — identical on server and on the first client
  // render — so React hydrates cleanly. After mount, the render
  // switches to the operator's local zone.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // Re-render on the relative-style ticker so "5 seconds ago" doesn't
  // get stale. Cheap — one setInterval per relative-style instance.
  const [, force] = useState(0);
  useEffect(() => {
    if (style !== "relative") return;
    const t = setInterval(() => force((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [style]);

  if (ts === null || ts === undefined || ts === "") {
    return <span className={className}>{fallback}</span>;
  }
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) {
    return <span className={className}>{fallback}</span>;
  }

  const tooltip = title ?? d.toISOString();
  return (
    <span
      className={className}
      title={tooltip}
      // data-utc carries the canonical UTC ISO for tooling that wants
      // an unambiguous value regardless of what locale the text shows.
      data-utc={d.toISOString()}
    >
      {mounted ? format(d, style) : formatUtcFallback(d, style)}
    </span>
  );
}

function format(d: Date, style: LocalTimeStyle): string {
  switch (style) {
    case "date":
      return d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    case "time":
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    case "iso":
      // Local-zone ISO: `2026-05-18T13:45:21+10:00`. Useful for filter
      // inputs that round-trip back to local zone.
      return formatLocalIso(d);
    case "relative":
      return formatRelative(d);
    case "datetime":
    default:
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
  }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/**
 * Stable UTC string used for both server render and the first client
 * render. Locale-independent so both sides produce the same bytes —
 * once the client mounts we swap to the locale-aware formatter.
 *
 * The pre-mount text is shown for a single paint only, so the format
 * mirrors `format(d, style)` closely enough that the swap doesn't
 * cause obvious layout reflow.
 */
function formatUtcFallback(d: Date, style: LocalTimeStyle): string {
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  const s = pad(d.getUTCSeconds());
  switch (style) {
    case "date":
      return `${Y}-${M}-${D}`;
    case "time":
      return `${h}:${m}:${s}`;
    case "iso":
      return `${Y}-${M}-${D}T${h}:${m}:${s}Z`;
    case "relative":
      // Pre-mount we don't know "now" in the operator's zone, so emit
      // the absolute UTC time and let the post-mount render swap to
      // "5 minutes ago" once the client clock is available.
      return `${Y}-${M}-${D} ${h}:${m}:${s} UTC`;
    case "datetime":
    default:
      return `${Y}-${M}-${D} ${h}:${m}:${s}`;
  }
}

function formatLocalIso(d: Date): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function formatRelative(d: Date): string {
  const diffMs = d.getTime() - Date.now();
  const past = diffMs < 0;
  const absSec = Math.round(Math.abs(diffMs) / 1000);
  const units: Array<{ s: number; label: Intl.RelativeTimeFormatUnit }> = [
    { s: 60, label: "second" },
    { s: 3600, label: "minute" },
    { s: 86_400, label: "hour" },
    { s: 604_800, label: "day" },
    { s: 2_629_800, label: "week" },
    { s: 31_557_600, label: "month" },
    { s: Number.POSITIVE_INFINITY, label: "year" },
  ];
  // Find the smallest unit larger than the absolute seconds; use the
  // one below it as the unit + divide.
  let prev = { s: 1, label: "second" as Intl.RelativeTimeFormatUnit };
  for (const u of units) {
    if (absSec < u.s) {
      const value = Math.max(1, Math.floor(absSec / prev.s));
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
      return rtf.format(past ? -value : value, prev.label);
    }
    prev = u;
  }
  return "—";
}
