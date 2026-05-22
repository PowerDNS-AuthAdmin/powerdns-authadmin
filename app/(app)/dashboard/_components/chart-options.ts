/**
 * app/(app)/dashboard/_components/chart-options.ts
 *
 * Pure ECharts option builders for the dashboard. Server-rendered and
 * serializable — each takes already-fetched rows and returns a plain option
 * object shipped as a prop to the `<Chart>` client wrapper. Extracted from
 * page.tsx to keep the page focused on data-fetching + layout.
 */

import type { HourlyBucket } from "@/lib/db/repositories/dashboard";

/** Fill missing hours with 0 so line charts show continuous time. Buckets
 *  align on UTC hours to match the database's `date_trunc('hour', ts)`. */
function fillHourly(rows: HourlyBucket[], hours: number): Array<{ hour: Date; count: number }> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const h = startOfHourUtc(new Date(row.bucket)).getTime();
    map.set(h, (map.get(h) ?? 0) + row.count);
  }
  const out: Array<{ hour: Date; count: number }> = [];
  const end = startOfHourUtc(new Date());
  for (let i = hours - 1; i >= 0; i--) {
    const hour = new Date(end.getTime() - i * 3600 * 1000);
    out.push({ hour, count: map.get(hour.getTime()) ?? 0 });
  }
  return out;
}

function startOfHourUtc(d: Date): Date {
  const out = new Date(d);
  out.setUTCMinutes(0, 0, 0);
  return out;
}

export function hourlyLineOption(rows: HourlyBucket[], hours: number, label: string) {
  const filled = fillHourly(rows, hours);
  return {
    tooltip: { trigger: "axis" as const },
    // `type: "time"` lets ECharts format every tick label in the
    // BROWSER's local timezone — the server is upstream of timezone
    // decisions and shouldn't be baking "08:00" into category labels.
    // Data points are [iso-string, count] pairs; the browser places
    // them on the time axis and produces local-zone tick labels.
    xAxis: {
      // No `boundaryGap` on a time axis — it isn't a category axis, and
      // echarts 6 types it as a tuple there. Time axes place points exactly.
      type: "time" as const,
      splitLine: { show: false },
    },
    yAxis: {
      type: "value" as const,
      minInterval: 1,
      splitLine: { show: false },
    },
    series: [
      {
        name: label,
        type: "line" as const,
        smooth: true,
        symbol: "none" as const,
        areaStyle: { opacity: 0.2 },
        data: filled.map((row) => [row.hour.toISOString(), row.count]),
      },
    ],
  };
}

export function multiSeriesOption(
  rows: Array<{
    serverSlug: string;
    serverName: string;
    sampledAt: Date;
    zoneCount: number | null;
    latencyP95Ms: number | null;
  }>,
  field: "zoneCount" | "latencyP95Ms",
  axisLabel: string,
) {
  const bySlug = new Map<string, { name: string; data: Array<[string, number]> }>();
  for (const row of rows) {
    const value = row[field];
    if (value === null || value === undefined) continue;
    const entry =
      bySlug.get(row.serverSlug) ??
      bySlug.set(row.serverSlug, { name: row.serverName, data: [] }).get(row.serverSlug)!;
    entry.data.push([new Date(row.sampledAt).toISOString(), value]);
  }
  const series = Array.from(bySlug.values()).map((entry) => ({
    name: entry.name,
    type: "line" as const,
    smooth: true,
    symbol: "circle" as const,
    symbolSize: 4,
    data: entry.data,
  }));

  return {
    tooltip: { trigger: "axis" as const },
    legend: bySlug.size > 1 ? { top: 0 } : undefined,
    xAxis: { type: "time" as const, splitLine: { show: false } },
    yAxis: { type: "value" as const, name: axisLabel, splitLine: { show: false } },
    series,
  };
}

export function topActorsOption(
  rows: Array<{ email: string; name: string | null; count: number }>,
) {
  return {
    tooltip: { trigger: "axis" as const, axisPointer: { type: "shadow" as const } },
    grid: { left: 100 },
    xAxis: { type: "value" as const, splitLine: { show: false } },
    yAxis: {
      type: "category" as const,
      data: rows.map((r) => r.name ?? r.email),
      inverse: true,
      splitLine: { show: false },
    },
    series: [
      {
        name: "Events",
        type: "bar" as const,
        data: rows.map((r) => r.count),
        itemStyle: { borderRadius: [0, 4, 4, 0] },
      },
    ],
  };
}

export function actionPieOption(rows: Array<{ action: string; count: number }>) {
  return {
    tooltip: { trigger: "item" as const, confine: true },
    // Same lane split as MapPieChart: donut left, truncating legend right,
    // so long action names (e.g. "zone.metadata.update") never overlap the
    // chart. Full name stays available in the tooltip.
    legend: {
      orient: "vertical" as const,
      type: "scroll" as const,
      left: "52%" as const,
      top: "middle" as const,
      icon: "circle" as const,
      itemWidth: 9,
      itemHeight: 9,
      itemGap: 8,
      textStyle: { fontSize: 11, overflow: "truncate" as const, width: 150 },
    },
    series: [
      {
        type: "pie" as const,
        radius: ["45%", "65%"] as [string, string],
        center: ["26%", "50%"] as [string, string],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: "transparent", borderWidth: 1 },
        label: { show: false },
        data: rows.map((r) => ({ name: r.action, value: r.count })),
      },
    ],
  };
}

/**
 * PDNS reports `response-sizes` as a fine-grained histogram (one bucket
 * per ~20–400 byte step), which makes a donut with a dozen tiny numeric
 * legend entries. Collapse those into a handful of human-readable size
 * ranges and emit them largest-first so the chart reads as a clean,
 * ordered size distribution. Returns the MapPieChart `entries` shape
 * (value as a string); pair with `preserveOrder` so the chart keeps this
 * size order instead of re-sorting by count.
 */
const RESPONSE_SIZE_BUCKETS: Array<{ label: string; max: number }> = [
  { label: "≤ 64 B", max: 64 },
  { label: "65–128 B", max: 128 },
  { label: "129–256 B", max: 256 },
  { label: "257–512 B", max: 512 },
  { label: "513 B – 1 KB", max: 1024 },
  { label: "1 – 2 KB", max: 2048 },
  { label: "> 2 KB", max: Infinity },
];

export function bucketResponseSizes(
  entries: Array<{ name: string; value: string }>,
): Array<{ name: string; value: string }> {
  const sums = new Map<string, number>();
  for (const e of entries) {
    const size = Number(e.name);
    const count = Number(e.value) || 0;
    if (!Number.isFinite(size) || count <= 0) continue;
    const bucket =
      RESPONSE_SIZE_BUCKETS.find((b) => size <= b.max) ??
      RESPONSE_SIZE_BUCKETS[RESPONSE_SIZE_BUCKETS.length - 1]!;
    sums.set(bucket.label, (sums.get(bucket.label) ?? 0) + count);
  }
  // Walk the buckets large→small so the legend/slices are size-ordered
  // (descending), dropping any range with no traffic.
  return RESPONSE_SIZE_BUCKETS.slice()
    .reverse()
    .filter((b) => sums.has(b.label))
    .map((b) => ({ name: b.label, value: String(sums.get(b.label)!) }));
}

export function sessionsOption(rows: Array<{ sampledAt: Date; activeSessions: number }>) {
  return {
    tooltip: { trigger: "axis" as const },
    xAxis: { type: "time" as const, splitLine: { show: false } },
    yAxis: { type: "value" as const, minInterval: 1, splitLine: { show: false } },
    series: [
      {
        name: "Active sessions",
        type: "line" as const,
        smooth: true,
        symbol: "none" as const,
        areaStyle: { opacity: 0.2 },
        data: rows.map((row) => [new Date(row.sampledAt).toISOString(), row.activeSessions]),
      },
    ],
  };
}
