import { describe, expect, it } from "vitest";
import {
  isNextRunDue,
  awaitingFirstResults,
  compareNameserverSets,
  compareResults,
  countVerdicts,
  formatDuration,
  formatInterval,
  replaceResult,
  summarizeFindings,
  verdictOf,
  type ZoneMonitorResult,
  type ZoneMonitorState,
} from "./zone-monitor-format";

function resultOf(
  zone: string,
  severity: ZoneMonitorResult["severity"],
  server = "primary",
): ZoneMonitorResult {
  return {
    zone,
    server,
    horizon: "public",
    checkedAt: "2026-10-20T10:00:00.000Z",
    durationMs: 120,
    severity,
    findings: severity ? [{ code: "x", severity, title: "t", detail: "d" }] : [],
    summary: {
      delegation: "delegated",
      parentNameservers: [],
      apexNameservers: [],
      nameservers: [],
      resolvers: [],
      dnssec: { signed: false, dsAtParent: 0, dnskeys: 0 },
      reverse: null,
      serial: 1,
    },
  };
}

function stateOf(
  results: ZoneMonitorResult[],
  extra: Partial<ZoneMonitorState> = {},
): ZoneMonitorState {
  return {
    enabled: true,
    intervalMs: 900_000,
    lastCycleAt: "2026-10-20T10:00:00.000Z",
    nextCycleAt: "2026-10-20T10:15:00.000Z",
    running: false,
    offline: false,
    results,
    counts: countVerdicts(results),
    ...extra,
  };
}

describe("formatInterval", () => {
  it("picks the largest whole unit", () => {
    expect(formatInterval(15 * 60_000)).toBe("every 15 minutes");
    expect(formatInterval(60_000)).toBe("every 1 minute");
    expect(formatInterval(2 * 3_600_000)).toBe("every 2 hours");
    expect(formatInterval(90_000)).toBe("every 90 seconds");
    expect(formatInterval(45_000)).toBe("every 45 seconds");
  });
});

describe("formatDuration", () => {
  it("shows milliseconds below a second and one decimal above", () => {
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(1234)).toBe("1.2 s");
    expect(formatDuration(1000)).toBe("1.0 s");
  });
});

describe("compareResults", () => {
  it("sorts worst first, then by zone", () => {
    const sorted = [
      resultOf("b.example.", null),
      resultOf("z.example.", "warn"),
      resultOf("a.example.", null),
      resultOf("m.example.", "error"),
      resultOf("c.example.", "info"),
    ].sort(compareResults);
    expect(sorted.map((r) => r.zone)).toEqual([
      "m.example.",
      "z.example.",
      "c.example.",
      "a.example.",
      "b.example.",
    ]);
    expect(verdictOf(sorted[0]!)).toBe("error");
    expect(verdictOf(sorted[4]!)).toBe("ok");
  });
});

describe("summarizeFindings", () => {
  it("headlines the worst finding regardless of order", () => {
    expect(
      summarizeFindings([
        { code: "a", severity: "info", title: "Minor", detail: "" },
        { code: "b", severity: "error", title: "Major", detail: "" },
        { code: "c", severity: "warn", title: "Medium", detail: "" },
      ]),
    ).toEqual({ count: 3, headline: "Major" });
    expect(summarizeFindings([])).toEqual({ count: 0, headline: null });
  });
});

describe("compareNameserverSets", () => {
  it("unions both sides case- and dot-insensitively and flags each side", () => {
    expect(
      compareNameserverSets(
        ["NS1.example.com.", "ns2.example.com"],
        ["ns2.example.com.", "ns3.example.com."],
      ),
    ).toEqual([
      { name: "ns1.example.com.", inApex: true, inParent: false },
      { name: "ns2.example.com.", inApex: true, inParent: true },
      { name: "ns3.example.com.", inApex: false, inParent: true },
    ]);
  });
});

describe("replaceResult", () => {
  it("swaps the matching zone on the same backend, recounts and keeps the order", () => {
    const state = stateOf([resultOf("a.example.", "error"), resultOf("b.example.", null)]);
    const next = replaceResult(state, resultOf("a.example.", null));
    expect(next.results.map((r) => [r.zone, r.severity])).toEqual([
      ["a.example.", null],
      ["b.example.", null],
    ]);
    expect(next.counts).toEqual({ zones: 2, error: 0, warn: 0, info: 0, ok: 2 });
    expect(next.lastCycleAt).toBe(state.lastCycleAt);
  });

  it("treats the same zone on another backend as a separate row", () => {
    const state = stateOf([resultOf("a.example.", null, "primary")]);
    const next = replaceResult(state, resultOf("a.example.", "warn", "secondary"));
    expect(next.results).toHaveLength(2);
    expect(next.counts.warn).toBe(1);
  });
});

describe("awaitingFirstResults", () => {
  it("polls while enabled with no zone checked yet, whatever the cycle state", () => {
    expect(awaitingFirstResults(stateOf([], { lastCycleAt: null }))).toBe(true);
    expect(awaitingFirstResults(stateOf([], { running: true }))).toBe(true);
    // A completed cycle with no rows still polls: new zones are probed within
    // seconds and the realtime bus has no row to announce until then.
    expect(awaitingFirstResults(stateOf([]))).toBe(true);
    expect(awaitingFirstResults(stateOf([], { lastCycleAt: null, enabled: false }))).toBe(false);
    expect(awaitingFirstResults(stateOf([resultOf("a.", null)], { running: true }))).toBe(false);
  });
});

describe("isNextRunDue", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  it("is due once the scheduled moment has passed", () => {
    expect(isNextRunDue("2026-10-21T09:59:50Z", now)).toBe(true);
    expect(isNextRunDue("2026-10-21T10:00:00Z", now)).toBe(true);
  });
  it("is not due before it, or without a schedule", () => {
    expect(isNextRunDue("2026-10-21T10:05:00Z", now)).toBe(false);
    expect(isNextRunDue(null, now)).toBe(false);
    expect(isNextRunDue("not a date", now)).toBe(false);
  });
});
