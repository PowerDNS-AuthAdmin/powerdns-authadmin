import { describe, expect, it } from "vitest";
import { decideHeaderChipMode } from "./header-chip-mode";

const baseInput = {
  pollingEnabled: true,
  realtimeAvailable: true,
  canReadBackends: true,
  hasReplicationTopology: true,
  anyLagging: false,
};

describe("decideHeaderChipMode", () => {
  it("returns sync(inSync=true) when every gate is satisfied and nothing is lagging", () => {
    expect(decideHeaderChipMode(baseInput)).toEqual({ kind: "sync", inSync: true });
  });

  it("returns sync(inSync=false) when something is lagging", () => {
    expect(decideHeaderChipMode({ ...baseInput, anyLagging: true })).toEqual({
      kind: "sync",
      inSync: false,
    });
  });

  it.each([
    ["pollingEnabled=false (default for v1.2.0)", { pollingEnabled: false }],
    ["realtime SSE unavailable", { realtimeAvailable: false }],
    ["actor can't read backends (profile-only user)", { canReadBackends: false }],
    ["fleet has no replication topology", { hasReplicationTopology: false }],
  ])("falls back to live mode when %s", (_label, override) => {
    expect(decideHeaderChipMode({ ...baseInput, ...override })).toEqual({ kind: "live" });
  });

  it("falls back to live even when topology exists, if polling is off", () => {
    // The most common 1.2.0 case: an upgraded primary+secondaries fleet whose
    // operator hasn't yet flipped PDNS_BACKGROUND_POLLING=true. The chip MUST
    // stay quiet - we'd otherwise render stale or empty sync state.
    expect(
      decideHeaderChipMode({
        ...baseInput,
        pollingEnabled: false,
        hasReplicationTopology: true,
        anyLagging: true,
      }),
    ).toEqual({ kind: "live" });
  });
});
