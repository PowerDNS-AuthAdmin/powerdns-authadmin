/**
 * lib/realtime/event-bus.ts
 *
 * App-wide event bus. Mutation routes call `publish*` after writing; the single
 * SSE endpoint (`/api/realtime`) subscribes via `subscribeAll` and forwards
 * everything to the browser, which filters client-side via `RealtimeProvider`.
 *
 * HA (ADR-0016): with `REDIS_URL` set, every event is ALSO published to a Redis
 * channel so a mutation on replica A reaches the SSE subscribers on replica B.
 * Each event carries the publishing instance's id; the Redis subscriber skips
 * its own messages, so the origin replica keeps an immediate in-process
 * fast-path (no Redis round-trip for its own clients) and remote replicas
 * deliver exactly once — no duplicates. Without Redis (single instance) it's
 * pure in-process; a Redis outage degrades to in-process (origin clients still
 * get events, cross-replica fan-out pauses until Redis returns).
 *
 * Listeners + the subscription flag live on `globalThis` so HMR / Next's
 * route-bundle duplication don't strand subscribers or double-subscribe.
 */

import "server-only";
import { randomUUID } from "node:crypto";
import { getRedis, getRedisSubscriber, isRedisEnabled } from "@/lib/redis";
import { logger } from "@/lib/logger";

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
    }
  | {
      // Backend-health advisory set changed (ADR-0015). Carries no detail — it's
      // a nudge for the health bell to re-render against the freshly-computed,
      // permission-scoped set. Published only when the visible set actually moved.
      type: "health.updated";
      at: string;
    };

type Listener = (event: RealtimeEvent) => void;

const REDIS_CHANNEL = "pda:realtime";

declare global {
  var __pdnsRealtimeBus:
    | {
        listeners: Set<Listener>;
        instanceId: string;
        // True while a `subscribe(REDIS_CHANNEL)` is in effect. Reset to false on
        // a subscribe failure so the call can be retried.
        redisSubscribed: boolean;
        // One-way latch: set the first time we attach the `message` listener and
        // NEVER reset. The subscriber lives on globalThis for the process life,
        // so re-attaching on each subscribe retry would deliver cross-replica
        // events N+1× (issue #4). The handler must register exactly once.
        redisHandlerAttached: boolean;
      }
    | undefined;
}
const bus = (globalThis.__pdnsRealtimeBus ??= {
  listeners: new Set<Listener>(),
  instanceId: randomUUID(),
  redisSubscribed: false,
  redisHandlerAttached: false,
});

/**
 * Subscribe to every event published anywhere on the bus (local + cross-replica
 * via Redis). Used by the single app-wide SSE endpoint. Returns an unsubscribe
 * function the endpoint MUST call on disconnect, or stranded listeners fan out
 * into dead controllers and grow the set unbounded.
 */
export function subscribeAll(listener: Listener): () => void {
  ensureRedisSubscription();
  bus.listeners.add(listener);
  return () => {
    bus.listeners.delete(listener);
  };
}

/** Local fan-out. Listener exceptions never break the publisher. */
function deliver(event: RealtimeEvent): void {
  for (const fn of bus.listeners) {
    try {
      fn(event);
    } catch {
      // Listener faults must never break the publisher.
    }
  }
}

/** Deliver locally now, and fan out to other replicas via Redis (best-effort). */
function emit(event: RealtimeEvent): void {
  deliver(event);
  if (!isRedisEnabled()) return;
  const redis = getRedis();
  if (!redis) return;
  void redis
    .publish(REDIS_CHANNEL, JSON.stringify({ instanceId: bus.instanceId, event }))
    .catch((err: unknown) =>
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "realtime.redis.publish.failed",
      ),
    );
}

/**
 * Subscribe this process to the Redis channel once, so events published by other
 * replicas reach this replica's SSE clients. Idempotent; messages from our own
 * instance are skipped (already delivered in-process by `emit`).
 */
function ensureRedisSubscription(): void {
  if (bus.redisSubscribed || !isRedisEnabled()) return;
  const sub = getRedisSubscriber();
  if (!sub) return;

  // Attach the message listener exactly once for the lifetime of the (globalThis
  // singleton) subscriber. `redisSubscribed` is reset on a subscribe failure to
  // permit a retry, but the listener must NOT be re-attached on that retry or
  // remote events fan out once per past failure (issue #4).
  if (!bus.redisHandlerAttached) {
    bus.redisHandlerAttached = true;
    sub.on("message", (channel: string, message: string) => {
      if (channel !== REDIS_CHANNEL) return;
      try {
        const parsed = JSON.parse(message) as { instanceId: string; event: RealtimeEvent };
        if (parsed.instanceId === bus.instanceId) return; // our own publish — already delivered
        deliver(parsed.event);
      } catch {
        // Malformed payload on the channel — ignore.
      }
    });
  }

  bus.redisSubscribed = true;
  sub.subscribe(REDIS_CHANNEL).catch((err: unknown) => {
    bus.redisSubscribed = false; // allow a later retry (without re-attaching the handler)
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "realtime.redis.subscribe.failed",
    );
  });
}

export function publishZoneEvent(event: RealtimeEvent): void {
  if (event.type !== "zone.updated" && event.type !== "zone.sync.changed") return;
  emit(event);
}

export function publishAuditEvent(event: RealtimeEvent): void {
  if (event.type !== "audit.appended") return;
  emit(event);
}

export function publishPdnsRequestEvent(event: RealtimeEvent): void {
  if (event.type !== "pdns.request.appended") return;
  emit(event);
}

export function publishHealthEvent(): void {
  emit({ type: "health.updated", at: new Date().toISOString() });
}
