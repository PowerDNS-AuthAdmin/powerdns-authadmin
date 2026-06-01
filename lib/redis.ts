/**
 * lib/redis.ts
 *
 * Optional Redis connectivity for multi-replica (HA) deployments. When
 * `REDIS_URL` is set, three otherwise per-process pieces of state become
 * cross-replica (ADR-0016):
 *   - login/sensitive rate limiting (`lib/auth/rate-limit.ts`),
 *   - the one-time reveal-token store (`lib/auth/temp-reveal-store.ts`),
 *   - the realtime SSE event bus (`lib/realtime/event-bus.ts`).
 *
 * Each of those degrades gracefully to its in-process implementation if Redis
 * is unset OR a command fails, so a single-node deploy needs no Redis and a
 * transient Redis outage never takes the app down - it just loses cross-replica
 * coordination until Redis returns.
 *
 * Two connections: a `main` client for commands and a dedicated `subscriber`
 * for pub/sub (ioredis, like the protocol, forbids regular commands on a
 * connection in subscriber mode). Both are globalThis singletons so Next's
 * route-bundle duplication doesn't open a connection per bundle.
 */

import "server-only";
import Redis from "ioredis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

declare global {
  var __pdnsRedis: { main: Redis | null; sub: Redis | null } | undefined;
}

const state = (globalThis.__pdnsRedis ??= { main: null, sub: null });

/** True when the operator has opted into Redis-backed HA coordination. */
export function isRedisEnabled(): boolean {
  return Boolean(env.REDIS_URL);
}

function makeClient(role: "main" | "subscriber"): Redis {
  // env.REDIS_URL is guaranteed defined at the call sites (isRedisEnabled gate).
  const client = new Redis(env.REDIS_URL!, {
    connectionName: `pda-${role}`,
    // Don't hang a request on a dead Redis - fail the command fast so the caller
    // falls back to its in-process path. ioredis keeps reconnecting in the
    // background per retryStrategy.
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    enableReadyCheck: true,
  });
  client.on("error", (err: Error) => {
    // Logged at warn (not error) - a Redis blip is a degraded-coordination
    // event, not an app fault; the callers carry on in-process.
    logger.warn({ role, err: err.message }, "redis.connection.error");
  });
  client.on("ready", () => logger.info({ role }, "redis.ready"));
  return client;
}

/** The shared command connection, or null when Redis isn't configured. */
export function getRedis(): Redis | null {
  if (!isRedisEnabled()) return null;
  state.main ??= makeClient("main");
  return state.main;
}

/** The dedicated pub/sub subscriber connection, or null when not configured. */
export function getRedisSubscriber(): Redis | null {
  if (!isRedisEnabled()) return null;
  state.sub ??= makeClient("subscriber");
  return state.sub;
}
