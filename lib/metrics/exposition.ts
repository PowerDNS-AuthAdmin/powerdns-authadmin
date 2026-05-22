/**
 * lib/metrics/exposition.ts
 *
 * Pure builder for Prometheus text-format exposition. We don't pull in
 * `prom-client` because the format is short, the metrics we expose are
 * known statically, and avoiding the dep keeps the build artifact lean.
 * The format itself is documented at
 * https://github.com/prometheus/docs/blob/main/content/docs/instrumenting/exposition_formats.md
 *
 * Conventions kept consistent across exporters:
 *   - All metric names prefixed `pdnsauthadmin_`.
 *   - Label values are quoted and have `\`, `"`, and `\n` escaped.
 *   - Labels with the same `name` collide on the Prometheus server
 *     side, so callers must ensure a stable label-name → metric-name
 *     mapping. `formatExposition` does not guard against this.
 *   - Trailing newline at end of output (per spec).
 *
 * No DB / runtime imports here — this is a pure data → string
 * transform so the unit test runs in isolation.
 */

export type MetricKind = "gauge" | "counter";

export interface MetricSample {
  /** Label set for this sample. `{}` for unlabeled metrics. */
  labels: Record<string, string>;
  value: number;
}

export interface MetricFamily {
  /** Full metric name including the `pdnsauthadmin_` prefix. */
  name: string;
  help: string;
  kind: MetricKind;
  samples: MetricSample[];
}

/**
 * Combine families into a single exposition string. Each family contributes
 * one HELP + TYPE header followed by every sample. Output ends with a
 * trailing newline as required by the format spec.
 *
 * Families with zero samples produce only the headers — operators see the
 * metric is exposed but currently has no data, which is more useful than
 * silently dropping it.
 */
export function formatExposition(families: readonly MetricFamily[]): string {
  const out: string[] = [];
  for (const fam of families) {
    out.push(`# HELP ${fam.name} ${escapeHelp(fam.help)}`);
    out.push(`# TYPE ${fam.name} ${fam.kind}`);
    for (const sample of fam.samples) {
      out.push(formatSample(fam.name, sample));
    }
  }
  return out.join("\n") + "\n";
}

function formatSample(name: string, sample: MetricSample): string {
  const labels = formatLabels(sample.labels);
  // Prometheus accepts NaN / +Inf / -Inf literally as text in the value
  // column. Plain Number.toString gives `Infinity`, which Prometheus
  // rejects — normalize to `+Inf` etc.
  const value = formatValue(sample.value);
  return labels ? `${name}{${labels}} ${value}` : `${name} ${value}`;
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`).join(",");
}

function escapeLabelValue(value: string): string {
  // Per the spec: escape `\`, `"`, and `\n`. Tabs and other control
  // characters pass through (they're rare in practice and Prometheus
  // tolerates them — over-escaping risks ambiguity).
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHelp(help: string): string {
  // HELP needs `\` and `\n` escaped (but NOT `"`). Per spec.
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function formatValue(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (v === Number.POSITIVE_INFINITY) return "+Inf";
  if (v === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(v);
}
