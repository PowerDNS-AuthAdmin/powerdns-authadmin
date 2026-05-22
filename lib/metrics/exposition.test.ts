import { describe, expect, it } from "vitest";
import { formatExposition, type MetricFamily } from "./exposition";

describe("formatExposition", () => {
  it("emits HELP + TYPE + sample lines and a trailing newline", () => {
    const out = formatExposition([
      {
        name: "pdnsauthadmin_up",
        help: "1 if the app is up.",
        kind: "gauge",
        samples: [{ labels: {}, value: 1 }],
      },
    ]);
    expect(out).toBe(
      "# HELP pdnsauthadmin_up 1 if the app is up.\n" +
        "# TYPE pdnsauthadmin_up gauge\n" +
        "pdnsauthadmin_up 1\n",
    );
  });

  it("sorts labels alphabetically for stable diffs", () => {
    const out = formatExposition([
      {
        name: "x",
        help: "h",
        kind: "gauge",
        samples: [{ labels: { b: "B", a: "A", c: "C" }, value: 1 }],
      },
    ]);
    expect(out).toContain('x{a="A",b="B",c="C"} 1');
  });

  it("escapes label values per spec", () => {
    const out = formatExposition([
      {
        name: "x",
        help: "h",
        kind: "gauge",
        samples: [
          {
            labels: { server: 'path\\slash"quote' + String.fromCharCode(10) + "newline" },
            value: 1,
          },
        ],
      },
    ]);
    expect(out).toContain('x{server="path\\\\slash\\"quote\\nnewline"} 1');
  });

  it("formats non-finite values per Prometheus convention", () => {
    const out = formatExposition([
      {
        name: "x",
        help: "h",
        kind: "gauge",
        samples: [
          { labels: { v: "nan" }, value: NaN },
          { labels: { v: "pinf" }, value: Number.POSITIVE_INFINITY },
          { labels: { v: "ninf" }, value: Number.NEGATIVE_INFINITY },
        ],
      },
    ]);
    expect(out).toContain('x{v="nan"} NaN');
    expect(out).toContain('x{v="pinf"} +Inf');
    expect(out).toContain('x{v="ninf"} -Inf');
  });

  it("emits headers even when a family has no samples", () => {
    const out = formatExposition([
      {
        name: "pdnsauthadmin_zones_total",
        help: "Zones per backend.",
        kind: "gauge",
        samples: [],
      },
    ]);
    expect(out).toBe(
      "# HELP pdnsauthadmin_zones_total Zones per backend.\n" +
        "# TYPE pdnsauthadmin_zones_total gauge\n",
    );
  });

  it("escapes backslash and newline in HELP but leaves quotes alone", () => {
    const out = formatExposition([
      {
        name: "x",
        help: 'one\\two\nthree"four',
        kind: "gauge",
        samples: [],
      },
    ]);
    expect(out).toContain('# HELP x one\\\\two\\nthree"four');
  });

  it("preserves family order across multiple families", () => {
    const fams: MetricFamily[] = [
      { name: "a", help: "ah", kind: "gauge", samples: [{ labels: {}, value: 1 }] },
      { name: "b", help: "bh", kind: "counter", samples: [{ labels: {}, value: 2 }] },
    ];
    const out = formatExposition(fams);
    expect(out.indexOf("a 1")).toBeLessThan(out.indexOf("b 2"));
  });

  it("uses the bare metric name (no braces) when labels are empty", () => {
    const out = formatExposition([
      {
        name: "x",
        help: "h",
        kind: "gauge",
        samples: [{ labels: {}, value: 42 }],
      },
    ]);
    expect(out).toContain("x 42");
    expect(out).not.toContain("x{} 42");
  });
});
