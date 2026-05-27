/**
 * app/metrics/route.ts
 *
 * GET /metrics — Prometheus exposition. Pulls the latest sample row
 * per backend + the latest app-wide row from `metric_samples` and
 * formats them as text-format gauges.
 *
 * Gating:
 *   - `env.METRICS_ENABLED` (default true) — when false, returns 404.
 *   - `env.METRICS_TOKEN` — required `Authorization: Bearer <token>`.
 *     Always present at runtime: the operator pins one in env, or
 *     `lib/env.ts` auto-generates a random 32-char token on every boot
 *     (logged once at startup) so /metrics is never accidentally open
 *     on a shared LAN. To opt out of the endpoint entirely, set
 *     `METRICS_ENABLED=false`. Constant-time compare via timingSafeEqual.
 *
 * Cache control: `no-store`. Prometheus scrapers won't honor it
 * either way, but reverse proxies caching `/metrics` is a known
 * incident shape — explicit `no-store` keeps the path clean.
 */

import { timingSafeEqual } from "node:crypto";
import { eq, sql, and, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { metricSamples } from "@/lib/db/schema";
import { pdnsServers } from "@/lib/db/schema";
import { formatExposition, type MetricFamily } from "@/lib/metrics/exposition";
import { logger } from "@/lib/logger";

export async function GET(request: Request): Promise<Response> {
  if (!env.METRICS_ENABLED) {
    return new Response("Not found", { status: 404 });
  }

  if (env.METRICS_TOKEN) {
    const auth = request.headers.get("authorization") ?? "";
    const presented = /^bearer\s+(.+)$/i.exec(auth.trim())?.[1]?.trim() ?? "";
    if (!constantTimeEqualString(presented, env.METRICS_TOKEN)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="metrics"' },
      });
    }
  }

  try {
    const families = await collectFamilies();
    const body = formatExposition(families);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : "unknown" }, "metrics.scrape.failed");
    return new Response("Internal error", { status: 500 });
  }
}

async function collectFamilies(): Promise<MetricFamily[]> {
  const [perServer, appWide] = await Promise.all([latestPerServer(), latestAppWide()]);

  // Up gauge — always 1 when the handler executes (Prometheus scrape
  // failure surfaces as `up{job=...}=0` on the scraper side).
  const up: MetricFamily = {
    name: "pdnsauthadmin_up",
    help: "1 if the metrics endpoint served a sample, 0 otherwise.",
    kind: "gauge",
    samples: [{ labels: {}, value: 1 }],
  };

  const zones: MetricFamily = {
    name: "pdnsauthadmin_pdns_zones",
    help: "Number of zones on each configured PDNS backend (last sampled).",
    kind: "gauge",
    samples: perServer
      .filter((r) => r.zoneCount !== null)
      .map((r) => ({
        labels: { server: r.serverSlug },
        value: r.zoneCount ?? 0,
      })),
  };

  const latencyP50: MetricFamily = {
    name: "pdnsauthadmin_pdns_request_latency_p50_ms",
    help: "p50 latency of PDNS HTTP requests over the previous sampling window, in ms.",
    kind: "gauge",
    samples: perServer
      .filter((r) => r.latencyP50Ms !== null)
      .map((r) => ({
        labels: { server: r.serverSlug },
        value: r.latencyP50Ms ?? 0,
      })),
  };

  const latencyP95: MetricFamily = {
    name: "pdnsauthadmin_pdns_request_latency_p95_ms",
    help: "p95 latency of PDNS HTTP requests over the previous sampling window, in ms.",
    kind: "gauge",
    samples: perServer
      .filter((r) => r.latencyP95Ms !== null)
      .map((r) => ({
        labels: { server: r.serverSlug },
        value: r.latencyP95Ms ?? 0,
      })),
  };

  const sessions: MetricFamily = {
    name: "pdnsauthadmin_active_sessions",
    help: "Count of unexpired session rows at the last sample.",
    kind: "gauge",
    samples: appWide?.activeSessions != null ? [{ labels: {}, value: appWide.activeSessions }] : [],
  };

  return [up, zones, latencyP50, latencyP95, sessions];
}

interface PerServerRow {
  serverSlug: string;
  zoneCount: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
}

async function latestPerServer(): Promise<PerServerRow[]> {
  const subquery = db
    .select({
      serverId: metricSamples.serverId,
      maxTs: sql<Date>`MAX(${metricSamples.sampledAt})`.as("max_ts"),
    })
    .from(metricSamples)
    .where(isNotNull(metricSamples.serverId))
    .groupBy(metricSamples.serverId)
    .as("latest");

  const rows = await db
    .select({
      serverSlug: pdnsServers.slug,
      zoneCount: metricSamples.zoneCount,
      latencyP50Ms: metricSamples.latencyP50Ms,
      latencyP95Ms: metricSamples.latencyP95Ms,
    })
    .from(pdnsServers)
    .leftJoin(subquery, eq(subquery.serverId, pdnsServers.id))
    .leftJoin(
      metricSamples,
      and(eq(metricSamples.serverId, pdnsServers.id), eq(metricSamples.sampledAt, subquery.maxTs)),
    )
    .where(isNull(pdnsServers.disabledAt))
    .orderBy(pdnsServers.slug);

  return rows.map((r) => ({
    serverSlug: r.serverSlug,
    zoneCount: r.zoneCount ?? null,
    latencyP50Ms: r.latencyP50Ms ?? null,
    latencyP95Ms: r.latencyP95Ms ?? null,
  }));
}

async function latestAppWide(): Promise<{ activeSessions: number | null } | null> {
  const rows = await db
    .select({
      activeSessions: metricSamples.activeSessions,
    })
    .from(metricSamples)
    .where(isNull(metricSamples.serverId))
    .orderBy(sql`${metricSamples.sampledAt} DESC`)
    .limit(1);
  return rows[0] ?? null;
}

function constantTimeEqualString(a: string, b: string): boolean {
  // `timingSafeEqual` requires equal-length buffers — wrap in an
  // outer length check that's deliberately *not* constant-time
  // because length-leak is acceptable here (the token is fixed
  // length per deployment).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
