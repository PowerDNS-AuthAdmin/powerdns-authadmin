/**
 * lib/realtime/zone-poller.ts
 *
 * The single, app-wide background poller. Drives three jobs at
 * staggered cadences from one timer:
 *
 *   • 30 s  — zone-state cache refresh + serial-change events (this
 *             module's primary job, matches the cache TTL).
 *   • 60 s  — PDNS `/statistics` sampling into `pdns_server_stats`
 *             (was a separate `pdns-stats-sampler` invocation).
 *   • 5 min — backend health snapshot into `metric_samples`
 *             (was a separate `sampler.ensureFreshSample` invocation).
 *
 * Reusing the same `listZones()` call across the first two jobs means
 * we don't double-hit the backend. The 5-min snapshot also reuses the
 * zone-count we already have in hand.
 *
 * Lazy-started: any SSE subscriber + the dashboard page call
 * `ensurePollerRunning()`. The poller stops after IDLE_SHUTDOWN_AFTER_MS
 * with zero subscribers — keeps PDNS calls cheap when nobody's looking.
 *
 * Events published:
 *   • `zone.updated` whenever a zone's `serial` or `edited_serial`
 *     changes between consecutive polls (covers operator edits + AXFR
 *     pulls + serial bumps from outside our app).
 */

import "server-only";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { logger } from "@/lib/logger";
import { redact } from "@/lib/errors/redact";
import { db } from "@/lib/db";
import { metricSamples } from "@/lib/db/schema";
import { pdnsServerStats } from "@/lib/db/schema";
import { drainPdnsLatency } from "@/lib/pdns/observations";
import {
  readCachedZones,
  writeCachedZones,
  type CachedZoneSnapshot,
} from "@/lib/pdns/zone-state-cache";
import { publishZoneEvent } from "./event-bus";

const POLL_INTERVAL_MS = 30_000;
// When a poll cycle observes any primary↔secondary serial mismatch
// (replication in flight), schedule a follow-up at this cadence so
// the chip flips back to "live" within seconds of AXFR completing —
// not 30 s later on the next regular tick. Steady state stays at the
// 30 s cadence above.
const IN_FLIGHT_FOLLOWUP_MS = 2_500;
const STATS_INTERVAL_MS = 60_000;
const METRIC_SAMPLE_INTERVAL_MS = 5 * 60_000;
const IDLE_SHUTDOWN_AFTER_MS = 5 * 60 * 1000;

declare global {
  var __pdnsZonePoller:
    | {
        timer: NodeJS.Timeout | null;
        subscriberCount: number;
        lastSubscriberAt: number;
        lastStatsSampleAt: number;
        lastMetricSampleAt: number;
      }
    | undefined;
}
const state = (globalThis.__pdnsZonePoller ??= {
  timer: null,
  subscriberCount: 0,
  lastSubscriberAt: Date.now(),
  lastStatsSampleAt: 0,
  lastMetricSampleAt: 0,
});

/** Register a subscriber. Starts the poller if it isn't already running. */
export function registerPollerSubscriber(): () => void {
  state.subscriberCount++;
  state.lastSubscriberAt = Date.now();
  ensurePollerRunning();
  return () => {
    state.subscriberCount = Math.max(0, state.subscriberCount - 1);
  };
}

export function ensurePollerRunning(): void {
  // Treat every call as a heartbeat — keeps the idle-shutdown timer
  // from firing while server-side pages still render against fresh
  // data even without an SSE subscriber.
  state.lastSubscriberAt = Date.now();
  if (state.timer) return;
  state.timer = setInterval(() => {
    void pollOnce().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.cycle.failed",
      );
    });
    // Idle shutdown: when nothing's listening for IDLE_SHUTDOWN_AFTER_MS,
    // stop polling. The next subscriber re-arms the timer.
    if (
      state.subscriberCount === 0 &&
      Date.now() - state.lastSubscriberAt > IDLE_SHUTDOWN_AFTER_MS
    ) {
      stopPoller();
    }
  }, POLL_INTERVAL_MS);
  // Kick off an immediate first poll instead of waiting POLL_INTERVAL_MS.
  void pollOnce().catch(() => undefined);
}

export function stopPoller(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/**
 * Kick an immediate poll cycle outside the regular 30s timer. Used by
 * the realtime bus right after a mutation publishes a zone event — the
 * cache otherwise stays stale until the next scheduled tick (up to
 * 30 s later), which makes the in-flight "syncing" state invisible to
 * the operator who just clicked Apply.
 *
 * Debounced: at most one extra poll per 1 s, even if a burst of
 * mutations publish multiple events. The regular interval continues
 * untouched.
 */
let immediatePollPending = false;
export function scheduleImmediatePoll(): void {
  if (immediatePollPending) return;
  immediatePollPending = true;
  setTimeout(() => {
    immediatePollPending = false;
    void pollOnce().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.immediate.failed",
      );
    });
  }, 1_000);
}

/**
 * One poll cycle. Hits every active backend; updates the cache; emits
 * events for zones whose serial changed. Exported for tests + the
 * "Refresh now" admin button if we ever add one.
 *
 * Also opportunistically samples `/statistics` (60 s cadence) and
 * `metric_samples` (5 min cadence) so we have a single poller doing
 * all background PDNS work — no more separate sampler call paths.
 */
export async function pollOnce(): Promise<void> {
  const backends = await listAllActiveBackends();
  if (backends.length === 0) return;

  // Resolve every backend to its operator-facing slug. For primaries
  // that's the row's own slug; for secondaries that's their parent
  // primary's slug. Operators view zones via the primary, so events
  // need to fan out to the primary's channel even when a secondary's
  // poll observed the change (e.g. AXFR caught up).
  const slugById = new Map(backends.map((b) => [b.id, b.slug]));
  const channelSlugById = new Map<string, string>();
  for (const b of backends) {
    if (b.role === "primary") {
      channelSlugById.set(b.id, b.slug);
    } else if (b.primaryId && slugById.has(b.primaryId)) {
      channelSlugById.set(b.id, slugById.get(b.primaryId)!);
    } else {
      channelSlugById.set(b.id, b.slug);
    }
  }

  const now = Date.now();
  const dueForStats = now - state.lastStatsSampleAt >= STATS_INTERVAL_MS;
  const dueForMetric = now - state.lastMetricSampleAt >= METRIC_SAMPLE_INTERVAL_MS;
  const sampledAt = new Date(now);
  if (dueForStats) state.lastStatsSampleAt = now;
  if (dueForMetric) state.lastMetricSampleAt = now;

  const metricRows: Array<typeof metricSamples.$inferInsert> = [];
  const statsRows: Array<typeof pdnsServerStats.$inferInsert> = [];

  // Two-phase commit to avoid a race that made the servers-page chip
  // flicker on "desynced" even when both primary + secondary had
  // caught up:
  //
  // (per-backend, parallel): fetch listZones, build the
  //          new snapshot, AND diff against the previous cache to
  //          collect events. We do NOT publish yet, and we do NOT
  //          write the cache yet.
  //
  // (after all backends complete): write every backend's
  //          new cache state atomically (sync, in-process), THEN
  //          publish every collected event.
  //
  // Why: previously a browser refresh triggered by primary's
  // "serial changed" event could land at the server BEFORE the
  // secondary's per-backend block had written its updated cache —
  // so `computeSecondarySync` (which reads `rawCache()`) saw the
  // new primary serial alongside the OLD secondary serial, and
  // reported "desynced". With the two-phase commit, by the time
  // ANY event reaches a subscriber, EVERY backend's cache already
  // reflects the just-fetched state.

  interface BackendPollResult {
    backendId: string;
    snapshots: CachedZoneSnapshot[] | null; // null = fetch failed, skip cache write
    pendingEvents: Array<{ zoneName: string; channelSlug: string }>;
  }
  const pollResults: BackendPollResult[] = [];

  await Promise.all(
    backends.map(async (b) => {
      try {
        const client = getPdnsClientForRow(b);
        const list = await client.listZones();
        const snapshots: CachedZoneSnapshot[] = list.map((z) => ({
          name: z.name,
          serial: z.serial ?? null,
          editedSerial: z.edited_serial ?? null,
          notifiedSerial: z.notified_serial ?? null,
          kind: z.kind,
          dnssec: z.dnssec ?? false,
        }));

        const channelSlug = channelSlugById.get(b.id) ?? b.slug;
        const previous = readCachedZones(b.id);
        const pendingEvents: BackendPollResult["pendingEvents"] = [];
        if (previous) {
          for (const cur of snapshots) {
            const prev = previous.zones.get(cur.name);
            if (prev?.serial !== cur.serial || prev.editedSerial !== cur.editedSerial) {
              pendingEvents.push({ zoneName: cur.name, channelSlug });
            }
          }
        }
        pollResults.push({ backendId: b.id, snapshots, pendingEvents });

        // 5-min backend snapshot reuses the zone-count we already have
        // plus the in-process latency drain — no extra PDNS call.
        if (dueForMetric) {
          const latency = drainPdnsLatency(b.slug);
          metricRows.push({
            serverId: b.id,
            sampledAt,
            zoneCount: list.length,
            latencyP50Ms: latency?.p50 ?? null,
            latencyP95Ms: latency?.p95 ?? null,
            activeSessions: null,
          });
        }

        // 60-s statistics sample. Separate HTTP call but cheap.
        if (dueForStats) {
          try {
            const stats = await client.statistics();
            for (const entry of stats) {
              if (entry.type === "StatisticItem") {
                const n = Number(entry.value);
                if (!Number.isFinite(n)) continue;
                statsRows.push({
                  ts: sampledAt,
                  serverId: b.id,
                  name: entry.name,
                  value: n,
                });
              } else if (entry.type === "MapStatisticItem") {
                statsRows.push({
                  ts: sampledAt,
                  serverId: b.id,
                  name: entry.name,
                  mapValue: entry.value,
                });
              }
            }
          } catch (err) {
            logger.warn(
              {
                server: b.slug,
                err: err instanceof Error ? redact(err.message) : "unknown",
              },
              "pdns.zone-poller.stats.failed",
            );
          }
        }
      } catch (err) {
        // Don't write cache or queue events for backends that
        // failed to fetch — their cache stays at the last known
        // good state.
        pollResults.push({ backendId: b.id, snapshots: null, pendingEvents: [] });
        logger.warn(
          {
            server: b.slug,
            err: err instanceof Error ? redact(err.message) : "unknown",
          },
          "pdns.zone-poller.fetch.failed",
        );
      }
    }),
  );

  // future work — atomic-from-subscribers'-POV cache commit. Write every
  // successful backend's new state synchronously, THEN publish every
  // queued event. Any router.refresh triggered by an event will read
  // a cache where ALL backends reflect the same poll cycle's data.
  const now2 = new Date().toISOString();
  for (const r of pollResults) {
    if (r.snapshots !== null) {
      writeCachedZones(r.backendId, r.snapshots);
    }
  }
  for (const r of pollResults) {
    for (const ev of r.pendingEvents) {
      publishZoneEvent({
        type: "zone.updated",
        zone: ev.zoneName,
        serverSlug: ev.channelSlug,
        actor: null,
        at: now2,
      });
    }
  }

  // Single-shot DB writes outside the per-backend Promise.all so a slow
  // insert doesn't block subsequent polls.
  if (metricRows.length > 0) {
    try {
      await db.insert(metricSamples).values(metricRows);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.metric-samples.failed",
      );
    }
  }
  if (statsRows.length > 0) {
    const CHUNK = 100;
    for (let i = 0; i < statsRows.length; i += CHUNK) {
      const slice = statsRows.slice(i, i + CHUNK);
      try {
        await db.insert(pdnsServerStats).values(slice);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : "unknown" },
          "pdns.zone-poller.stats-insert.failed",
        );
        break;
      }
    }
  }

  // If any primary↔secondary serial mismatch is now visible in the
  // cache (replication in flight), chain a quick follow-up poll so
  // we observe the catch-up and broadcast an event within seconds —
  // not 30 s on the next regular tick. Steady state (everything
  // matches) skips this entirely.
  if (anyInFlight(backends)) {
    scheduleFollowupPoll();
  }
}

/**
 * Detect any primary↔secondary serial mismatch in the just-updated
 * cache for ZONES THAT ARE EXPECTED TO REPLICATE. Native zones
 * (kind="Native") aren't AXFR'd, so them being absent on the
 * secondary is fine — counting them as in-flight would chain
 * follow-up polls indefinitely on any primary that hosts one.
 */
function anyInFlight(
  backends: ReadonlyArray<{ id: string; role: "primary" | "secondary"; primaryId: string | null }>,
): boolean {
  const primariesById = new Map(backends.filter((b) => b.role === "primary").map((b) => [b.id, b]));
  for (const s of backends) {
    if (s.role !== "secondary" || !s.primaryId) continue;
    if (!primariesById.has(s.primaryId)) continue;
    const primaryEntry = readCachedZones(s.primaryId);
    const secondaryEntry = readCachedZones(s.id);
    if (!primaryEntry || !secondaryEntry) continue;
    for (const [zoneName, primarySnap] of primaryEntry.zones) {
      if (primarySnap.kind !== "Master" && primarySnap.kind !== "Primary") continue;
      const secondarySnap = secondaryEntry.zones.get(zoneName);
      if (!secondarySnap) return true;
      if (primarySnap.serial !== secondarySnap.serial) return true;
    }
  }
  return false;
}

let followupPollPending = false;
function scheduleFollowupPoll(): void {
  if (followupPollPending) return;
  followupPollPending = true;
  setTimeout(() => {
    followupPollPending = false;
    void pollOnce().catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.followup.failed",
      );
    });
  }, IN_FLIGHT_FOLLOWUP_MS);
}
