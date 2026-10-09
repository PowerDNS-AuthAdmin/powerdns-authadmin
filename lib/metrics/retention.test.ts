import { describe, expect, it } from "vitest";
import {
  DASHBOARD_METRIC_SAMPLES_WINDOW_MS,
  DASHBOARD_PDNS_STATS_WINDOW_MS,
} from "./dashboard-windows";
import {
  METRIC_SAMPLES_RETENTION_MS,
  PDNS_REQUESTS_RETENTION_MS,
  PDNS_SERVER_STATS_RETENTION_MS,
  _resetRetentionForTests,
} from "./retention";

describe("retention windows", () => {
  it("metric_samples retention is exactly the dashboard's display window (1:1)", () => {
    // Wired to the same constant the dashboard reads - change one, both follow.
    // We keep nothing the dashboard doesn't show.
    expect(METRIC_SAMPLES_RETENTION_MS).toBe(DASHBOARD_METRIC_SAMPLES_WINDOW_MS);
  });

  it("pdns_server_stats retention is exactly the dashboard's widget window (1:1)", () => {
    expect(PDNS_SERVER_STATS_RETENTION_MS).toBe(DASHBOARD_PDNS_STATS_WINDOW_MS);
  });

  it("metric_samples window defaults to 7 days", () => {
    expect(DASHBOARD_METRIC_SAMPLES_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("pdns_server_stats window defaults to 2 hours", () => {
    expect(DASHBOARD_PDNS_STATS_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("pdns_requests retention follows PDNS_REQUEST_LOG_RETENTION_DAYS (default 7 days)", () => {
    // The request log has no display window to track, so it is an operator
    // knob; the unit suite runs with the env default.
    expect(PDNS_REQUESTS_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("_resetRetentionForTests doesn't throw (used by integration test setup)", () => {
    expect(() => _resetRetentionForTests()).not.toThrow();
  });
});
