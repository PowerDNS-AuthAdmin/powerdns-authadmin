/**
 * components/realtime/reconnect-policy.ts
 *
 * When the browser's own EventSource retry cannot be trusted. Safari (and
 * Chrome on battery) freezes background tabs; on resume the stream is often
 * dead without an `error` event, or stuck in CONNECTING indefinitely, and the
 * header chip reads "connecting" until the operator reloads. The provider
 * instead measures silence against the server heartbeat and reopens the
 * stream itself - the page never reloads.
 */

/** Server heartbeat cadence (app/api/realtime/route.ts). */
export const HEARTBEAT_MS = 25_000;
/** Silence longer than this on an OPEN stream means it is dead. */
export const STALE_MS = HEARTBEAT_MS * 2 + 10_000;
/** A stream that has not opened within this is reopened rather than waited on. */
export const CONNECT_TIMEOUT_MS = 10_000;
/** How often the watchdog looks while the tab is visible. */
export const WATCHDOG_MS = 5_000;

/** EventSource.readyState values, named so the policy reads without the DOM type. */
export const READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSED: 2 } as const;

export interface StreamObservation {
  readyState: number;
  /** Last `open`, `ready` or any message, ms since epoch. */
  lastSeenAt: number;
  /** When this EventSource was created, ms since epoch. */
  openedAt: number;
  now: number;
}

/** True when the provider should discard this EventSource and open a new one. */
export function shouldReopen(o: StreamObservation): boolean {
  if (o.readyState === READY_STATE.CLOSED) return true;
  if (o.readyState === READY_STATE.CONNECTING) return o.now - o.openedAt > CONNECT_TIMEOUT_MS;
  return o.now - o.lastSeenAt > STALE_MS;
}
