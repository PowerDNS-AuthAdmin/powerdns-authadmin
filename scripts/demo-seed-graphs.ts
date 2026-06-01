/**
 * scripts/demo-seed-graphs.ts
 *
 * DEMO / SCREENSHOTS ONLY — never run against a real deployment.
 *
 * Backfills the time-series tables the dashboard charts read from so a freshly
 * booted demo stack shows full, realistic-looking graphs instead of empty
 * panels. It touches NO application code — it just writes rows the dashboard
 * already knows how to render:
 *
 *   • metric_samples     → "Zones per backend", "p95 latency",
 *                          "Active sessions (7d)", backends-snapshot table
 *                          (lib/db/repositories/dashboard.ts:
 *                           backendSeries / latestBackendSamples / sessionsSeries)
 *   • pdns_server_stats  → per-backend stat cards: query rate, latency, packet-
 *                          cache hit ratio, response-by-qtype / -rcode / -sizes
 *                          (lib/metrics/pdns-stats-sampler.ts: readRecentMetrics)
 *   • audit_log          → "Record changes 24h", "Logins 24h", "Top actors 7d",
 *                          "Action breakdown 7d", "Recent activity"
 *
 * The PDNS-stats tab (the graph-heavy one) only renders when the stack runs with
 * PDNS_BACKGROUND_POLLING=true. The combined demo compose sets that; if you run
 * elsewhere, enable it before shooting that tab.
 *
 * Works against whatever DATABASE_URL points at (Postgres for the combined demo,
 * SQLite for the minimal one) because it goes through the same Drizzle db +
 * dialect-agnostic schema as the app.
 *
 * Re-runnable: it first deletes its own prior rows (metric_samples /
 * pdns_server_stats within the dashboard windows, and audit rows tagged with the
 * `demo-seed:` request-id prefix), so repeated runs don't stack.
 *
 * Usage:
 *   DEMO_SEED=1 npm run demo:seed:graphs        # or pass --yes
 *   # against the combined demo's Postgres from the host:
 *   DATABASE_URL=postgres://pdns:pdns@localhost:5432/powerdns_authadmin \
 *     DEMO_SEED=1 npm run demo:seed:graphs
 */

import { gte, like } from "drizzle-orm";
import { closeDatabase, db } from "@/lib/db";
import { auditLog, metricSamples, pdnsServers, pdnsServerStats, users } from "@/lib/db/schema";
import {
  DASHBOARD_METRIC_SAMPLES_WINDOW_MS,
  DASHBOARD_PDNS_STATS_WINDOW_MS,
} from "@/lib/metrics/dashboard-windows";
import { logger } from "@/lib/logger";

// Marker stamped on every synthetic audit row so re-runs (and cleanup) can find
// exactly what this script wrote without touching real audit history.
const DEMO_REQUEST_PREFIX = "demo-seed:";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// --- Deterministic RNG so re-runs produce identical-looking graphs ----------
// (Math.random would work in a plain script, but a seeded generator keeps the
//  screenshots stable across runs.)
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xc0ffee);
const jitter = (base: number, spread: number) => base + (rng() * 2 - 1) * spread;
/** Diurnal 0..1 wave peaking mid-afternoon, for "busier during the day" shapes. */
function diurnal(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  return 0.45 + 0.55 * Math.sin(((h - 9) / 24) * 2 * Math.PI);
}

// Postgres caps a statement at 65535 bind params, so large backfills are split
// into chunks. The caller supplies the insert closure so row types stay precise
// (no `any`) across the dual-dialect schema.
async function inChunks<T>(
  rows: T[],
  insert: (chunk: T[]) => Promise<unknown>,
  chunk = 500,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await insert(rows.slice(i, i + chunk));
  }
}

async function seedMetricSamples(serverIds: string[], now: number): Promise<void> {
  const stepMs = 15 * MINUTE;
  const windowStart = now - DASHBOARD_METRIC_SAMPLES_WINDOW_MS;

  await db.delete(metricSamples).where(gte(metricSamples.sampledAt, new Date(windowStart)));

  const rows: Array<typeof metricSamples.$inferInsert> = [];
  // Per-backend: a slowly-growing zone count + latency percentiles that wobble
  // with a daily rhythm. Each backend gets its own baseline so the multi-series
  // lines are visually distinct.
  serverIds.forEach((serverId, idx) => {
    const zoneBase = 40 + idx * 18;
    const p50Base = 7 + idx * 2;
    for (let t = windowStart; t <= now; t += stepMs) {
      const at = new Date(t);
      const progress = (t - windowStart) / DASHBOARD_METRIC_SAMPLES_WINDOW_MS;
      const wave = diurnal(at);
      rows.push({
        serverId,
        sampledAt: at,
        zoneCount: Math.round(zoneBase + progress * 12 + jitter(0, 1)),
        latencyP50Ms: Math.max(1, jitter(p50Base + wave * 4, 1.5)),
        latencyP95Ms: Math.max(2, jitter(p50Base * 2.4 + wave * 10, 4)),
        activeSessions: null,
      });
    }
  });
  // App-wide rows (serverId null) carry active-session count for its own chart.
  for (let t = windowStart; t <= now; t += stepMs) {
    const at = new Date(t);
    rows.push({
      serverId: null,
      sampledAt: at,
      zoneCount: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      activeSessions: Math.max(0, Math.round(jitter(3 + diurnal(at) * 14, 2))),
    });
  }

  await inChunks(rows, (c) => db.insert(metricSamples).values(c));
  logger.info({ rows: rows.length, servers: serverIds.length }, "demo-seed.metric_samples");
}

async function seedPdnsServerStats(serverIds: string[], now: number): Promise<void> {
  const stepMs = MINUTE;
  const windowStart = now - DASHBOARD_PDNS_STATS_WINDOW_MS;

  await db.delete(pdnsServerStats).where(gte(pdnsServerStats.ts, new Date(windowStart)));

  // Latest-snapshot map metrics — the dashboard pies read only the most recent
  // sample, so one representative distribution per server is enough.
  const qtype = [
    { name: "A", value: "812043" },
    { name: "AAAA", value: "377512" },
    { name: "MX", value: "61204" },
    { name: "TXT", value: "48933" },
    { name: "NS", value: "39127" },
    { name: "PTR", value: "27510" },
    { name: "SRV", value: "11842" },
    { name: "SOA", value: "8021" },
  ];
  const rcode = [
    { name: "0", value: "1248831" }, // NOERROR
    { name: "3", value: "121044" }, // NXDOMAIN
    { name: "2", value: "20913" }, // SERVFAIL
    { name: "5", value: "9120" }, // REFUSED
  ];
  const sizes = [
    { name: "32", value: "201443" },
    { name: "48", value: "318922" },
    { name: "64", value: "287114" },
    { name: "96", value: "164238" },
    { name: "144", value: "88210" },
    { name: "256", value: "39127" },
    { name: "512", value: "12044" },
    { name: "1232", value: "3318" },
  ];

  const rows: Array<typeof pdnsServerStats.$inferInsert> = [];
  serverIds.forEach((serverId, idx) => {
    // Cumulative counters start at a believable lifetime total and grow each
    // minute; the dashboard diffs consecutive samples into a per-second rate.
    let udp4 = 5_000_000 + idx * 1_200_000;
    let udp6 = 1_400_000 + idx * 300_000;
    let tcp4 = 220_000 + idx * 40_000;
    let tcp6 = 60_000 + idx * 9_000;
    let hit = 9_800_000 + idx * 1_000_000;
    let miss = 640_000 + idx * 70_000;
    const qpsBase = 140 + idx * 35;

    for (let t = windowStart; t <= now; t += stepMs) {
      const at = new Date(t);
      const wave = diurnal(at);
      const qps = Math.max(5, jitter(qpsBase * wave, qpsBase * 0.12));
      const perMin = qps * 60;
      udp4 += Math.round(perMin * 0.72);
      udp6 += Math.round(perMin * 0.2);
      tcp4 += Math.round(perMin * 0.06);
      tcp6 += Math.round(perMin * 0.02);
      // ~88–95% cache hit ratio: hits grow ~10× misses.
      const missInc = Math.round(perMin * 0.07 + jitter(0, 1));
      hit += Math.round(perMin * 0.9);
      miss += Math.max(0, missInc);

      const counter = (name: string, value: number) => ({ serverId, ts: at, name, value });
      rows.push(counter("udp4-queries", udp4));
      rows.push(counter("udp6-queries", udp6));
      rows.push(counter("tcp4-queries", tcp4));
      rows.push(counter("tcp6-queries", tcp6));
      rows.push(counter("packetcache-hit", hit));
      rows.push(counter("packetcache-miss", miss));
      // `latency` in PDNS is an average in microseconds (gauge), rendered as-is.
      rows.push(counter("latency", Math.round(jitter(420 + wave * 260, 70))));
    }

    // One trailing map sample per metric → becomes the "latest" the pies read.
    const at = new Date(now);
    rows.push({ serverId, ts: at, name: "response-by-qtype", value: null, mapValue: qtype });
    rows.push({ serverId, ts: at, name: "response-by-rcode", value: null, mapValue: rcode });
    rows.push({ serverId, ts: at, name: "response-sizes", value: null, mapValue: sizes });
  });

  await inChunks(rows, (c) => db.insert(pdnsServerStats).values(c));
  logger.info({ rows: rows.length, servers: serverIds.length }, "demo-seed.pdns_server_stats");
}

async function seedAuditLog(now: number): Promise<void> {
  const actors = await db.select({ id: users.id }).from(users).limit(8);
  if (actors.length === 0) {
    logger.warn("demo-seed.audit: no users found — skipping audit backfill");
    return;
  }

  // Clear only our own prior synthetic rows; real audit history is untouched.
  await db.delete(auditLog).where(like(auditLog.requestId, `${DEMO_REQUEST_PREFIX}%`));

  // Weighted action vocabulary. `record.%` dominates so the edits chart is
  // lively; logins are frequent enough to fill the logins chart.
  const ACTIONS: Array<{ action: string; resourceType: string; weight: number }> = [
    { action: "record.create", resourceType: "record", weight: 22 },
    { action: "record.update", resourceType: "record", weight: 26 },
    { action: "record.delete", resourceType: "record", weight: 10 },
    { action: "auth.login.success", resourceType: "user", weight: 20 },
    { action: "zone.create", resourceType: "zone", weight: 5 },
    { action: "zone.update", resourceType: "zone", weight: 6 },
    { action: "role.assignment.created", resourceType: "user", weight: 3 },
    { action: "user.update", resourceType: "user", weight: 3 },
    { action: "tsig.create", resourceType: "tsig", weight: 2 },
    { action: "server.update", resourceType: "server", weight: 3 },
  ];
  const totalWeight = ACTIONS.reduce((s, a) => s + a.weight, 0);
  const pickAction = () => {
    let r = rng() * totalWeight;
    for (const a of ACTIONS) {
      r -= a.weight;
      if (r <= 0) return a;
    }
    return ACTIONS[0]!;
  };
  const ZONES = ["example.com.", "ps-6.demo.", "internal.test.", "shop.example.net.", "vpn.corp."];

  const rows: Array<typeof auditLog.$inferInsert> = [];
  let seq = 0;
  // Walk 7 days hour-by-hour; more events during business hours, and an extra
  // density bump over the last 24h so the 24h hourly charts read as busy.
  for (let t = now - 7 * 24 * HOUR; t <= now; t += HOUR) {
    const at = new Date(t);
    const ageHours = (now - t) / HOUR;
    const recentBoost = ageHours <= 24 ? 1.8 : 1;
    const expected = diurnal(at) * 9 * recentBoost;
    const count = Math.max(0, Math.round(jitter(expected, 2)));
    for (let i = 0; i < count; i++) {
      const a = pickAction();
      const actor = actors[Math.floor(rng() * actors.length)]!;
      const offset = Math.floor(rng() * HOUR);
      rows.push({
        ts: new Date(t + offset),
        actorType: "user",
        actorId: actor.id,
        action: a.action,
        resourceType: a.resourceType,
        resourceId:
          a.resourceType === "zone" || a.resourceType === "record"
            ? ZONES[Math.floor(rng() * ZONES.length)]!
            : actor.id,
        before: null,
        after: null,
        ip: null,
        userAgent: "Mozilla/5.0 (demo-seed)",
        requestId: `${DEMO_REQUEST_PREFIX}${seq++}`,
      });
    }
  }

  await inChunks(rows, (c) => db.insert(auditLog).values(c));
  logger.info({ rows: rows.length, actors: actors.length }, "demo-seed.audit_log");
}

async function main(): Promise<void> {
  if (process.env["DEMO_SEED"] !== "1" && !process.argv.includes("--yes")) {
    console.error(
      "Refusing to run without confirmation. This writes synthetic demo data into\n" +
        "metric_samples / pdns_server_stats / audit_log. Re-run with DEMO_SEED=1 (or\n" +
        "pass --yes). DEMO / SCREENSHOTS ONLY — never point this at a real database.",
    );
    process.exitCode = 1;
    return;
  }

  const now = Date.now();
  const servers = await db.select({ id: pdnsServers.id }).from(pdnsServers);
  const serverIds = servers.map((s) => s.id);
  if (serverIds.length === 0) {
    logger.warn(
      "demo-seed: no pdns_servers rows — backend/PDNS graphs will be empty. " +
        "Provision the demo servers first, then re-run.",
    );
  }

  logger.info({ servers: serverIds.length }, "demo-seed: starting graph backfill");
  await seedMetricSamples(serverIds, now);
  if (serverIds.length > 0) await seedPdnsServerStats(serverIds, now);
  await seedAuditLog(now);
  logger.info("demo-seed: done. Reload /dashboard to see populated graphs.");
}

main()
  .catch((err) => {
    logger.error({ err }, "demo-seed: failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDatabase();
  });
