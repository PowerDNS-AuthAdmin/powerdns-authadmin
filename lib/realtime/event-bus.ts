/**
 * lib/realtime/event-bus.ts
 *
 * In-process event bus. Mutation routes call `publish*` after
 * writing; the single app-wide SSE endpoint (`/api/realtime`)
 * subscribes via `subscribeAll` and forwards everything to the
 * browser, which filters client-side via the `RealtimeProvider`
 * context.
 *
 * Single-process only — for an HA deployment this needs to be backed
 * by Redis pub/sub or similar. The contract is intentionally tiny so
 * swapping the implementation later is a one-file change.
 *
 * Listeners are stored on `globalThis` so HMR doesn't strand
 * subscribers across module reloads in dev.
 */

import "server-only";

export type RealtimeEvent =
  | { type: "zone.updated"; zone: string; serverSlug: string; actor: string | null; at: string }
  | {
      type: "zone.sync.changed";
      zone: string;
      serverSlug: string;
      secondarySlug: string;
      state: "in-sync" | "ahead" | "lagging" | "missing" | "error";
      at: string;
    }
  | {
      type: "audit.appended";
      action: string;
      resourceType: string;
      resourceId: string | null;
      actorId: string | null;
      at: string;
    }
  | {
      type: "pdns.request.appended";
      serverSlug: string;
      op: string;
      method: string;
      responseStatus: number | null;
      at: string;
    };

type Listener = (event: RealtimeEvent) => void;

declare global {
  var __pdnsRealtimeBus: { listeners: Set<Listener> } | undefined;
}
const bus = (globalThis.__pdnsRealtimeBus ??= { listeners: new Set<Listener>() });

/**
 * Subscribe to every event published anywhere on the bus. Used by the
 * single app-wide SSE endpoint. Returns an unsubscribe function — the
 * SSE endpoint MUST call it on disconnect (request.signal abort) or
 * stranded listeners will fan-out into dead controllers and grow the
 * set unbounded.
 */
export function subscribeAll(listener: Listener): () => void {
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
  };
}

/** Internal fan-out. Listener exceptions never break the publisher. */
function deliver(event: RealtimeEvent): void {
  for (const fn of bus.listeners) {
    try {
      fn(event);
    } catch {
      // Listener faults must never break the publisher.
    }
  }
}

export function publishZoneEvent(event: RealtimeEvent): void {
  if (event.type !== "zone.updated" && event.type !== "zone.sync.changed") return;
  deliver(event);
}

export function publishAuditEvent(event: RealtimeEvent): void {
  if (event.type !== "audit.appended") return;
  deliver(event);
}

export function publishPdnsRequestEvent(event: RealtimeEvent): void {
  if (event.type !== "pdns.request.appended") return;
  deliver(event);
}
