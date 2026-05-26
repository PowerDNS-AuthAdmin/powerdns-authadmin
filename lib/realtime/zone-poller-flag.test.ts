/**
 * lib/realtime/zone-poller-flag.test.ts
 *
 * Pins the `PDNS_BACKGROUND_POLLING=false` (default) behaviour: the unified
 * background poller MUST NOT schedule a setInterval, and the post-mutation
 * `scheduleImmediatePoll` + in-flight `scheduleFollowupPoll` MUST be no-ops.
 *
 * Only `ensureBackendsObserved` should still execute its `pollOnce(full:true)`
 * work on demand (validated implicitly by the integration suite which boots
 * the stack with the flag ON; the off-mode equivalent boots without it and
 * is covered by `tests/integration/polling-off.test.ts`).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  pdnsBackgroundPollingEnabled: false,
  env: {},
  isProduction: false,
  isDevelopment: false,
  isTest: true,
}));

// Stub everything `zone-poller` reaches into so we don't need a live DB or
// PDNS — we only want to observe the scheduling behaviour.
vi.mock("@/lib/db/repositories/pdns-servers", () => ({
  listAllActiveBackends: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("./event-bus", () => ({
  publishHealthEvent: vi.fn(),
  publishZoneEvent: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit/request-context", () => ({
  withRequestId: (_id: string, fn: () => unknown) => fn(),
  newSystemRequestId: () => "test-req-id",
}));

describe("zone-poller respects PDNS_BACKGROUND_POLLING=false", () => {
  it("ensurePollerRunning schedules no setInterval when the flag is off", async () => {
    const { ensurePollerRunning } = await import("./zone-poller");
    const setInterval = vi.spyOn(global, "setInterval");
    try {
      ensurePollerRunning();
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
    }
  });

  it("scheduleImmediatePoll arms no setTimeout when the flag is off", async () => {
    const { scheduleImmediatePoll } = await import("./zone-poller");
    const setTimeout = vi.spyOn(global, "setTimeout");
    try {
      scheduleImmediatePoll();
      scheduleImmediatePoll();
      expect(setTimeout).not.toHaveBeenCalled();
    } finally {
      setTimeout.mockRestore();
    }
  });
});
