import { describe, expect, it } from "vitest";
import { CONNECT_TIMEOUT_MS, READY_STATE, STALE_MS, shouldReopen } from "./reconnect-policy";

const t0 = 1_700_000_000_000;

describe("shouldReopen", () => {
  it("keeps a fresh open stream", () => {
    expect(
      shouldReopen({ readyState: READY_STATE.OPEN, lastSeenAt: t0, openedAt: t0, now: t0 + 1000 }),
    ).toBe(false);
  });

  it("reopens an open stream that has gone silent past two heartbeats", () => {
    expect(
      shouldReopen({
        readyState: READY_STATE.OPEN,
        lastSeenAt: t0,
        openedAt: t0,
        now: t0 + STALE_MS + 1,
      }),
    ).toBe(true);
    expect(
      shouldReopen({
        readyState: READY_STATE.OPEN,
        lastSeenAt: t0,
        openedAt: t0,
        now: t0 + STALE_MS - 1,
      }),
    ).toBe(false);
  });

  it("gives a connecting stream a bounded wait before replacing it", () => {
    expect(
      shouldReopen({
        readyState: READY_STATE.CONNECTING,
        lastSeenAt: t0,
        openedAt: t0,
        now: t0 + CONNECT_TIMEOUT_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldReopen({
        readyState: READY_STATE.CONNECTING,
        lastSeenAt: t0,
        openedAt: t0,
        now: t0 + CONNECT_TIMEOUT_MS + 1,
      }),
    ).toBe(true);
  });

  it("always reopens a closed stream", () => {
    expect(
      shouldReopen({ readyState: READY_STATE.CLOSED, lastSeenAt: t0, openedAt: t0, now: t0 }),
    ).toBe(true);
  });
});
