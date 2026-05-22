"use client";

/**
 * components/ui/chart.tsx
 *
 * Thin wrapper over `echarts-for-react` that imports only the ECharts
 * modules the dashboard actually uses (line / bar / pie + tooltip / grid /
 * legend / canvas), keeping the client bundle far smaller than the full
 * `echarts` umbrella import.
 *
 * Default styling: 240–280px tall, transparent background (so design tokens
 * show through), monospace-ish tooltips. Consumers pass a `title` for the
 * card frame and `option` for the ECharts spec.
 */

import { use as echartsUse } from "echarts/core";
import { BarChart, LineChart, PieChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  DataZoomComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import ReactECharts from "echarts-for-react/lib/core";
import * as echarts from "echarts/core";
import type { EChartsOption } from "echarts";
import { useEffect, useState } from "react";

// Register every ECharts module we use BEFORE any component mounts. Doing
// this lazily inside useEffect causes "Q[l] is not a constructor" — ECharts
// instantiates the chart on first render, before any effect runs, so the
// chart-type constructors must already be registered at that point.
echartsUse([
  BarChart,
  LineChart,
  PieChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  DataZoomComponent,
  CanvasRenderer,
]);

interface ChartProps {
  option: EChartsOption;
  /** Height in px. Default 280. */
  height?: number;
  className?: string;
}

export function Chart({ option, height = 280, className = "" }: ChartProps) {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  // Re-read the theme after mount and on .dark mutation. ECharts itself
  // doesn't know about CSS variables so we react explicitly.
  useEffect(() => {
    const update = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    update();
    const obs = new MutationObserver(update);
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => obs.disconnect();
  }, []);

  // Inject sensible defaults that play with the design tokens.
  const themed = withThemeDefaults(option, theme);

  return (
    <div className={className} style={{ height }}>
      <ReactECharts
        echarts={echarts}
        option={themed}
        style={{ height: "100%", width: "100%" }}
        notMerge
        lazyUpdate
        opts={{ renderer: "canvas" }}
      />
    </div>
  );
}

/**
 * Merge minimal theme defaults — background, palette, fonts, tooltip styling
 * — onto the caller's option. We intentionally don't touch xAxis / yAxis
 * shape (their discriminated-union shape doesn't merge cleanly through spread);
 * call sites style axes themselves.
 */
function withThemeDefaults(option: EChartsOption, theme: "light" | "dark"): EChartsOption {
  const text = theme === "dark" ? "#d1d5db" : "#374151";
  const grid = theme === "dark" ? "#374151" : "#e5e7eb";

  return {
    backgroundColor: "transparent",
    textStyle: {
      color: text,
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    },
    color: [
      "#6366f1", // indigo (accent)
      "#10b981", // emerald
      "#f59e0b", // amber
      "#ef4444", // red
      "#8b5cf6", // violet
      "#06b6d4", // cyan
      "#ec4899", // pink
    ],
    ...option,
    // ECharts' legend doesn't inherit the top-level `textStyle.color`; if
    // we don't set it explicitly the labels render as a hardcoded #333
    // that vanishes against the dark-mode background. Merge our default
    // color on top of whatever the caller passed so existing legend
    // configs (`type`, `orient`, `data`, …) survive.
    legend: mergeLegend(option.legend, text),
    tooltip: {
      backgroundColor: theme === "dark" ? "rgba(17,24,39,0.95)" : "rgba(255,255,255,0.95)",
      borderColor: grid,
      borderWidth: 1,
      textStyle: { color: text, fontSize: 12 },
      ...(option.tooltip ?? {}),
    },
    grid: {
      left: 40,
      right: 16,
      top: 28,
      bottom: 28,
      containLabel: true,
      ...(option.grid ?? {}),
    },
  };
}

type LegendOption = EChartsOption["legend"];

function mergeLegend(legend: LegendOption, color: string): LegendOption {
  const defaults = { textStyle: { color } };
  if (legend === undefined) return defaults;
  if (Array.isArray(legend)) {
    return legend.map((l) => ({
      ...l,
      textStyle: { color, ...(l.textStyle ?? {}) },
    }));
  }
  return {
    ...legend,
    textStyle: { color, ...(legend.textStyle ?? {}) },
  };
}
