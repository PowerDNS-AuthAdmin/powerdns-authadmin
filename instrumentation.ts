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

  // Redis is the cross-replica coordination layer (ADR-0016): rate limiting,
  // realtime SSE fan-out, and reveal-once tokens go through it when set. When
  // unset everything runs in-process — correct for a single instance, but a
  // multi-replica deploy MUST set REDIS_URL (and share a Postgres DATABASE_URL)
  // or replicas won't share login throttling, SSE events, or reveal tokens.
  console.info(
    process.env["REDIS_URL"]
      ? "[startup] REDIS_URL set — rate limiting, realtime SSE fan-out, and reveal tokens are coordinated across replicas (HA-ready)."
      : "[startup] REDIS_URL not set — running single-instance (rate limiting, SSE fan-out, and reveal tokens are per-process). Set REDIS_URL + a shared Postgres for HA with >1 replica.",
  );

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
