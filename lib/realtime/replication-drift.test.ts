/**
 * lib/realtime/replication-drift.test.ts
 *
 * The pure drift-duration tracker that feeds the ADR-0015 drift advisory.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { getReplicationDriftMs, updateDriftDurations } from "./replication-drift";

// The map lives on globalThis; rebuild-from-empty clears it between cases.
beforeEach(() => {
  updateDriftDurations(new Set(), Date.now());
});

describe("updateDriftDurations", () => {
  it("reports 0 on first sighting, then grows from the original sighting time", () => {
    const t0 = 1_000_000;
    expect(updateDriftDurations(new Set(["a"]), t0).get("a")).toBe(0);
    // Same backend still lagging 5s later → duration measured from t0, not now.
    expect(updateDriftDurations(new Set(["a"]), t0 + 5000).get("a")).toBe(5000);
  });

  it("clears a backend once it catches up (drops out of the not-synced set)", () => {
    const t0 = 2_000_000;
    updateDriftDurations(new Set(["b"]), t0);
    updateDriftDurations(new Set(), t0 + 1000); // b caught up
    expect(getReplicationDriftMs("b")).toBeNull();
  });

  it("tracks each backend's lag independently", () => {
    const t0 = 3_000_000;
    updateDriftDurations(new Set(["x"]), t0);
    const d = updateDriftDurations(new Set(["x", "y"]), t0 + 2000);
    expect(d.get("x")).toBe(2000); // x has lagged since t0
    expect(d.get("y")).toBe(0); // y is new this cycle
  });

  it("getReplicationDriftMs returns null for a backend in sync", () => {
    expect(getReplicationDriftMs("never-seen")).toBeNull();
  });
});
