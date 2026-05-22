/**
 * instrumentation.ts
 *
 * Next.js calls `register()` once per server process at boot. We use
 * it to warm up the zone poller so PDNS stats keep landing in the DB
 * even when nobody is logged in — otherwise the poller is lazy-started
 * by authenticated page renders / SSE subscribers and the dashboard
 * grew a gap whenever the app sat idle for hours.
 *
 * We MUST NOT directly import server-only modules here. `instrumentation.ts`
 * is bundled separately from regular route handlers and Next.js 15 ignores
 * `serverExternalPackages` for it (vercel/next.js#53523) — even a dynamic
 * `await import(...)` traces through `lib/db` to `pg` / `better-sqlite3` and
 * webpack chokes on their `require('fs'|'path'|'stream')` calls.
 *
 * Instead we fire a localhost fetch to `/healthz` once the HTTP server
 * is listening. The healthz handler is a normal Node-runtime route, so
 * it respects `serverExternalPackages` and can call `ensurePollerRunning()`
 * via the regular import graph. After that first hit Docker's own
 * healthcheck (every 15 s) keeps the poller's heartbeat fresh, so the
 * idle-shutdown timer never fires.
 */

export function register() {
  // Edge runtime can't fetch http://127.0.0.1 in the way we need and
  // doesn't run our route handlers anyway.
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;

  // REDIS_URL is accepted by env validation and reserved for a future HA
  // setup, but nothing consumes it yet — the rate limiter, the realtime
  // event-bus, and the reveal-once token store are all in-process. Warn so a
  // configured-but-ignored REDIS_URL isn't mistaken for HA-readiness: across
  // more than one replica none of that state is shared.
  if (process.env["REDIS_URL"]) {
    console.warn(
      "[startup] REDIS_URL is set but Redis is not wired up yet — rate limiting, " +
        "realtime SSE fan-out, and reveal-once tokens run in-process (per-replica, " +
        "not shared). Fine for a single instance; not HA-safe across replicas.",
    );
  }

  // `register()` runs before the HTTP server is necessarily listening,
  // so we defer the kick by a short delay. Five seconds is generous —
  // Next.js typically binds within a second on cold boot. Fire-and-
  // forget: if it fails (server slower than expected), Docker's first
  // healthcheck will pick up the slack 30 s later.
  setTimeout(() => {
    const port = process.env["PORT"] ?? "3000";
    void fetch(`http://127.0.0.1:${port}/healthz`).catch(() => undefined);
  }, 5_000);
}
