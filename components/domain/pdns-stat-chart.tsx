"use client";

/**
 * Chart wrappers tuned for the per-server PDNS statistics we capture in
 * `pdns_server_stats`. Two shapes:
 *
 *   `<CounterRateChart>` — takes the raw (ts, value) samples of a
 *     cumulative counter and plots the per-second delta line. Suitable
 *     for `udp4-queries`, `query-cache-hit`, etc.
 *
 *   `<MapPieChart>` — takes the latest `MapStatisticItem` snapshot
 *     (`[{name, value}, ...]`) and renders a donut. Suitable for
 *     `response-by-qtype`, `response-by-rcode`, `response-sizes`.
 */

import { Chart } from "@/components/ui/chart";

interface Sample {
  ts: string;
  value: number;
}

interface CounterRateChartProps {
  /** Oldest first. `value` is the cumulative counter as stored. */
  samples: Sample[];
  /** Display label for the legend / tooltip. */
  label: string;
  height?: number;
  /** Y-axis title — e.g. "queries / s", "ms". Defaults to a generic "rate". */
  yAxisLabel?: string;
}

/**
 * Delta the cumulative counter between consecutive samples and divide by
 * the elapsed seconds. Drops any data point where the counter resets
 * (PDNS process restart → value resets to 0 → delta is huge negative);
 * we treat negative deltas as gaps.
 */
export function CounterRateChart({
  samples,
  label,
  height = 200,
  yAxisLabel,
}: CounterRateChartProps) {
  const points: Array<[string, number]> = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const dt = (new Date(cur.ts).getTime() - new Date(prev.ts).getTime()) / 1000;
    if (dt <= 0) continue;
    const dv = cur.value - prev.value;
    if (dv < 0) continue;
    points.push([cur.ts, dv / dt]);
  }
  return (
    <Chart
      height={height}
      option={{
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "time",
          axisLabel: { fontSize: 10 },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          name: yAxisLabel ?? "",
          nameTextStyle: { fontSize: 10 },
          axisLabel: { fontSize: 10 },
          minInterval: 1,
          splitLine: { show: false },
        },
        series: [
          {
            type: "line",
            name: label,
            data: points,
            showSymbol: false,
            smooth: true,
            areaStyle: { opacity: 0.12 },
            lineStyle: { width: 1.5 },
          },
        ],
        grid: { left: 48, right: 16, top: 16, bottom: 28 },
      }}
    />
  );
}

interface ValueLineChartProps {
  samples: Sample[];
  label: string;
  height?: number;
  yAxisLabel?: string;
}

/** Plot the raw values (no rate diff) — useful for gauges like `latency`,
 *  `cpu-iowait`, `fd-usage` that are point-in-time, not counters. */
export function ValueLineChart({ samples, label, height = 200, yAxisLabel }: ValueLineChartProps) {
  const points = samples.map((s) => [s.ts, s.value] as [string, number]);
  return (
    <Chart
      height={height}
      option={{
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "time",
          axisLabel: { fontSize: 10 },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          name: yAxisLabel ?? "",
          nameTextStyle: { fontSize: 10 },
          axisLabel: { fontSize: 10 },
          splitLine: { show: false },
        },
        series: [
          {
            type: "line",
            name: label,
            data: points,
            showSymbol: false,
            smooth: true,
            areaStyle: { opacity: 0.12 },
            lineStyle: { width: 1.5 },
          },
        ],
        grid: { left: 48, right: 16, top: 16, bottom: 28 },
      }}
    />
  );
}

interface MapPieChartProps {
  /** Latest `MapStatisticItem.value` — array of name/value pairs. */
  entries: Array<{ name: string; value: string }>;
  title?: string;
  height?: number;
  /** Hide buckets whose value is 0 (PDNS sends a bunch of zero-rcode rows). */
  hideZeros?: boolean;
  /**
   * By default slices are sorted by value (largest first) — right for
   * categorical maps like qtype/rcode. Set this to keep the caller's
   * order instead, for data that has a meaningful sequence of its own
   * (e.g. response-size buckets, which read best ordered by size).
   */
  preserveOrder?: boolean;
}

export function MapPieChart({
  entries,
  title,
  height = 240,
  hideZeros = true,
  preserveOrder = false,
}: MapPieChartProps) {
  const mapped = entries
    .map((e) => ({ name: e.name, value: Number(e.value) || 0 }))
    .filter((d) => (hideZeros ? d.value > 0 : true));
  const data = preserveOrder ? mapped : mapped.sort((a, b) => b.value - a.value);
  return (
    <Chart
      height={height}
      option={{
        ...(title ? { title: { text: title, textStyle: { fontSize: 12 }, left: 8, top: 4 } } : {}),
        tooltip: { trigger: "item", confine: true },
        // Donut sits in the left lane, legend in the right lane. The two
        // never overlap because the legend is anchored at left:"52%" (its
        // text grows rightward from there) while the donut's outer radius
        // is sized off the card *height*, keeping it well inside the left
        // half. `overflow: "truncate"` clips long rcode labels (e.g.
        // "Server Not Authoritative for zone / Not Authorized") with an
        // ellipsis instead of letting them sprawl across the chart — the
        // full name still shows in the hover tooltip.
        legend: {
          type: "scroll",
          orient: "vertical",
          left: "55%",
          top: "middle",
          icon: "circle",
          itemWidth: 9,
          itemHeight: 9,
          itemGap: 8,
          pageIconSize: 9,
          textStyle: { fontSize: 11, overflow: "truncate", width: 110 },
        },
        series: [
          {
            type: "pie",
            radius: ["38%", "60%"],
            center: ["24%", "50%"],
            data,
            itemStyle: { borderRadius: 3, borderColor: "transparent", borderWidth: 1 },
            label: { show: false },
            labelLine: { show: false },
          },
        ],
      }}
    />
  );
}
