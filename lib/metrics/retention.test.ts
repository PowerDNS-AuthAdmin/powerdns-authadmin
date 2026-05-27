import { describe, expect, it } from "vitest";
import {
  METRIC_SAMPLES_RETENTION_MS,
  PDNS_SERVER_STATS_RETENTION_MS,
  _resetRetentionForTests,
} from "./retention";

describe("retention windows", () => {
  it("metric_samples retention is 8 days (7-day dashboard window + 1-day buffer)", () => {
    expect(METRIC_SAMPLES_RETENTION_MS).toBe(8 * 24 * 60 * 60 * 1000);
  });

  it("pdns_server_stats retention is 24 hours", () => {
    expect(PDNS_SERVER_STATS_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("metric_samples buffer exceeds the dashboard's 7-day HOURS_7D window", () => {
    // Defends the boundary-row race: dashboard's `gte(sampledAt, since)`
    // query computes `since = now - 7d`, and a row that's exactly on that
    // edge must still be in the table when the query runs. Keeping at
    // least one extra day of rows guarantees that.
    const dashboardWindowMs = 7 * 24 * 60 * 60 * 1000;
    expect(METRIC_SAMPLES_RETENTION_MS).toBeGreaterThan(dashboardWindowMs);
  });

  it("_resetRetentionForTests doesn't throw (used by integration test setup)", () => {
    expect(() => _resetRetentionForTests()).not.toThrow();
  });
});
