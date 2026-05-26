/**
 * lib/realtime/zone-poller.ts
 *
 * The single, app-wide background poller. Drives several jobs at
 * staggered cadences from one timer:
 *
 *   • 30 s  — zone-state cache refresh + serial-change events (this
 *             module's primary job, matches the cache TTL).
 *   • 60 s  — "daemon refresh": `/statistics` into `pdns_server_stats`,
 *             a forced version re-probe (`/servers/{id}`), and the
 *             observed capability snapshot from `/config` +
 *             `/autoprimaries` (ADR-0014). Nothing about a backend's
 *             reachability/version/capabilities is cached longer than
 *             this — the UI always reflects the live poll.
 *   • 5 min — backend health snapshot into `metric_samples`.
 *
 * Reusing the same `listZones()` call across jobs means we don't
 * double-hit the backend. The 5-min snapshot also reuses the
 * zone-count we already have in hand.
 *
 * Lazy-started: any SSE subscriber + the dashboard page call
 * `ensurePollerRunning()`. While there are zero subscribers the cycle drops to
 * STATS-ONLY — it samples `/statistics` (+ the 5-min snapshot) so the time-series
 * graphs never gap, but skips the zone diff, daemon refresh, topology rebuild and
 * advisory eval. A subscriber (or a page warm-up / post-mutation poll) restores
 * the full cycle. `subscriberCount > 0` is the active indicator.
 *
 * Events published:
 *   • `zone.updated` whenever a zone's `serial` or `edited_serial`
 *     changes between consecutive polls (covers operator edits + AXFR
 *     pulls + serial bumps from outside our app).
 *   • `health.updated` whenever the bell-visible advisory set moves.
 */

import "server-only";
import { newSystemRequestId, withRequestId } from "@/lib/request-context";
import { listAllActiveBackends, markPdnsServersSeen } from "@/lib/db/repositories/pdns-servers";
import { countActiveSessions } from "@/lib/db/repositories/sessions";
import { getPdnsProbeClientForRow } from "@/lib/pdns/registry";
import { isReadOnlyMirror, isWriteCapable } from "@/lib/pdns/capabilities";
import { backendAddressSet, resolveMastersToBackendId } from "@/lib/pdns/topology-resolve";
import { rawDerivedTopology, writeDerivedTopology } from "@/lib/pdns/topology-cache";
import { evaluateBackendHealth } from "@/lib/health/evaluator";
import { missingReplicatedKeys } from "@/lib/health/replicated-keys";
import { syncBackendAdvisories } from "@/lib/db/repositories/backend-advisories";
import { probeDaemonMeta } from "./backend-health";
import { updateDriftDurations } from "./replication-drift";
import { getTsigMissingCount, setTsigMissingCounts } from "./tsig-presence";
import { listPrimarySecondaries } from "./tsig-replication";
import { recordBackendStatus } from "./backend-status";
import { PdnsAuthError } from "@/lib/pdns/errors";
import type { PdnsStatisticsEntry } from "@/lib/pdns/types";
import { logger } from "@/lib/logger";
import type { PdnsServer } from "@/lib/db/schema";
import { redact } from "@/lib/errors/redact";
import { db } from "@/lib/db";
import { metricSamples, type PdnsDaemonCapabilities } from "@/lib/db/schema";
import { pdnsServerStats } from "@/lib/db/schema";
import { drainPdnsLatency } from "@/lib/pdns/observations";
import {
  readCachedZones,
  writeCachedZones,
  type CachedZoneSnapshot,
} from "@/lib/pdns/zone-state-cache";
import { publishHealthEvent, publishZoneEvent } from "./event-bus";
import { pdnsBackgroundPollingEnabled } from "@/lib/env";

const POLL_INTERVAL_MS = 30_000;
// When a poll cycle observes any primary↔secondary serial mismatch
// (replication in flight), schedule a follow-up at this cadence so
// the chip flips back to "live" within seconds of AXFR completing —
// not 30 s later on the next regular tick. Steady state stays at the
// 30 s cadence above.
const IN_FLIGHT_FOLLOWUP_MS = 2_500;
// Cap on consecutive fast follow-ups for a single sustained mismatch.
// A transient AXFR catches up well within this window; a permanently
// broken replica would otherwise hot-loop the whole fleet every 2.5 s
// forever. Once capped, the regular 30 s tick keeps monitoring (and the
// drift advisory fires); an operator mutation resets the counter so a
// fresh change is still fast-tracked.
const MAX_CONSECUTIVE_FOLLOWUPS = 8;
// The 60 s "daemon refresh" cadence: /statistics, a forced version re-probe,
// and the capability snapshot (/config + /autoprimaries). Version + capabilities
// only change on a daemon restart, so 60 s is plenty fresh without re-reading
// them every 30 s zone cycle.
const STATS_INTERVAL_MS = 60_000;
const METRIC_SAMPLE_INTERVAL_MS = 5 * 60_000;

declare global {
  var __pdnsZonePoller:
    | {
        timer: NodeJS.Timeout | null;
        subscriberCount: number;
        lastSubscriberAt: number;
        lastStatsSampleAt: number;
        // The 60 s daemon refresh (version + capabilities + TSIG presence) has a
        // SEPARATE clock from the statistics sample so the stats-only idle path,
        // which advances `lastStatsSampleAt`, doesn't starve the daemon refresh —
        // the first full cycle after idle still re-probes promptly.
        lastDaemonRefreshAt: number;
        lastMetricSampleAt: number;
        consecutiveFollowups: number;
        // Re-entrancy guard: the in-flight cycle's promise (null when idle).
        // Concurrent callers JOIN it (await the same promise) and request a
        // single rerun, instead of overlapping (overlapping cycles double-hit
        // every backend and race the advisory upsert/prune). On `state` so it's
        // shared across route bundles via globalThis — a page's warm-up and the
        // timer coordinate on one cycle.
        pollInFlight: Promise<void> | null;
        rerunRequested: boolean;
        // Intent for the next coalesced iteration: run the FULL cycle (vs the
        // idle stats-only one). A full request mid-flight reruns as full.
        pendingFull: boolean;
        // When the last cycle completed (epoch ms) — drives the warm-up's
        // staleness check so a page reads the store without re-fetching.
        lastCycleAt: number;
        // When the last FULL cycle completed — the warm-up keys off THIS (not
        // `lastCycleAt`) so a recent stats-only cycle never lets a page read
        // stale zones without a full refresh.
        lastFullCycleAt: number;
      }
    | undefined;
}
const state = (globalThis.__pdnsZonePoller ??= {
  timer: null,
  subscriberCount: 0,
  lastSubscriberAt: Date.now(),
  lastStatsSampleAt: 0,
  lastDaemonRefreshAt: 0,
  lastMetricSampleAt: 0,
  consecutiveFollowups: 0,
  pollInFlight: null,
  rerunRequested: false,
  pendingFull: false,
  lastCycleAt: 0,
  lastFullCycleAt: 0,
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
  state.lastSubscriberAt = Date.now();
  // PDNS_BACKGROUND_POLLING=false (default) — no setInterval. Every PDNS
  // interaction is operator-initiated; supplementary sync-aware features are
  // surfaced as hidden in the UI. `ensureBackendsObserved` (the per-request
  // warm-up) still calls `pollOnce` directly, so pages keep working.
  if (!pdnsBackgroundPollingEnabled) return;
  if (state.timer) return;
  // The timer never self-stops: with zero subscribers it keeps ticking but each
  // cycle is STATS-ONLY (the only background work that should run when nobody's
  // looking — it backs the time-series graphs). `pollOnce()` with no `full`
  // resolves the cycle mode from `subscriberCount` at fire time.
  state.timer = setInterval(() => {
    // Each tick gets a fresh request id so its PDNS calls + any audit rows
    // are attributed to THIS tick, not to whichever route handler happened to
    // hold the next/headers AsyncLocalStorage scope when the timer fired.
    void withRequestId(newSystemRequestId(), () => pollOnce()).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.cycle.failed",
      );
    });
  }, POLL_INTERVAL_MS);
  // Kick off an immediate first FULL poll — a freshly-started poller was just
  // demanded by a subscriber or page render, so warm everything at once.
  void withRequestId(newSystemRequestId(), () => pollOnce({ full: true })).catch(() => undefined);
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
 * untouched. Resets the follow-up cap so a fresh operator change is
 * fast-tracked even after a previous sustained mismatch capped it.
 */
let immediatePollPending = false;
export function scheduleImmediatePoll(): void {
  // PDNS_BACKGROUND_POLLING=false → no eager background refresh after a
  // mutation. The mutation route still calls `invalidateBackendObservation`
  // and publishes its own SSE event, so the next page render refetches via
  // `ensureBackendsObserved` and the UI shows the new state on the next
  // navigation. No background cycle is the point of the flag.
  if (!pdnsBackgroundPollingEnabled) return;
  state.consecutiveFollowups = 0;
  if (immediatePollPending) return;
  immediatePollPending = true;
  setTimeout(() => {
    immediatePollPending = false;
    // A mutation just happened — always a FULL cycle so the operator sees the
    // zone/topology/advisory effects, even if no SSE subscriber is attached yet.
    // Fresh request id: this poll was *triggered by* the mutation but is its
    // own operation (different timestamp, different PDNS call set).
    void withRequestId(newSystemRequestId(), () => pollOnce({ full: true })).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.immediate.failed",
      );
    });
  }, 1_000);
}

/**
 * Run one poll cycle, guarded against overlap. The 30 s interval, the
 * post-mutation immediate poll, and the in-flight follow-up can all fire
 * concurrently; without this guard they'd run overlapping cycles that
 * double-hit every backend and race the advisory upsert/prune. Concurrent
 * callers coalesce into exactly one pending rerun.
 *
 * Exported for tests + the "Refresh now" admin button if we ever add one.
 */
export function pollOnce(opts?: { full?: boolean }): Promise<void> {
  // `full` defaults to "active right now" (a subscriber is attached). Callers
  // that represent a live demand — page warm-up, post-mutation, follow-up —
  // pass `full: true` explicitly so they aren't downgraded to stats-only.
  const wantFull = opts?.full ?? state.subscriberCount > 0;
  // Already running → join the in-flight cycle. Only ESCALATE to a rerun when a
  // FULL cycle is wanted but the in-flight one might be stats-only; a stats-only
  // request adds nothing a running cycle won't already cover.
  if (state.pollInFlight) {
    if (wantFull) {
      state.rerunRequested = true;
      state.pendingFull = true;
    }
    return state.pollInFlight;
  }
  // Set the shared handle before the first await so a concurrent caller can't
  // slip in and start a second cycle (no await between here and the assignment).
  state.pendingFull = wantFull;
  const p = runCoalescedCycles();
  state.pollInFlight = p;
  return p;
}

async function runCoalescedCycles(): Promise<void> {
  try {
    do {
      state.rerunRequested = false;
      const full = state.pendingFull;
      state.pendingFull = false;
      await runPollCycle({ full });
      if (full) state.lastFullCycleAt = Date.now();
    } while (state.rerunRequested);
  } finally {
    state.lastCycleAt = Date.now();
    state.pollInFlight = null;
  }
}

/**
 * Read-through warm-up for page renders: ensure the broker's store reflects a
 * recent observation, then return so the caller can read the caches. Serves
 * straight from the warm store when a cycle completed within `maxAgeMs` (the
 * common case — the background poll keeps it warm); otherwise runs/joins one
 * cycle and awaits it. This is how pages "ask the broker" instead of hitting
 * PDNS themselves.
 */
export async function ensureBackendsObserved(maxAgeMs: number = POLL_INTERVAL_MS): Promise<void> {
  ensurePollerRunning();
  // Key off the last FULL cycle: a recent stats-only (idle) cycle refreshed
  // neither zones nor topology, so it must NOT satisfy a page's read-through.
  if (state.lastFullCycleAt > 0 && Date.now() - state.lastFullCycleAt < maxAgeMs) return;
  await pollOnce({ full: true });
}

/**
 * Force the NEXT `ensureBackendsObserved()` to run a fresh full cycle instead of
 * serving the warm store. Call after a backend's config changes (add / edit /
 * delete) — especially its advertised addresses or group, which feed the derived
 * topology — so the immediately-following page render re-derives it rather than
 * showing the pre-change nesting for up to a poll interval. `scheduleImmediatePoll`
 * alone is debounced + async, so a post-save redirect can out-run it.
 */
export function invalidateBackendObservation(): void {
  state.lastFullCycleAt = 0;
  state.lastCycleAt = 0;
}

/**
 * One poll cycle. Hits every active backend; updates the cache; emits
 * events for zones whose serial changed; recomputes derived topology +
 * health advisories.
 *
 * Also opportunistically samples `/statistics` (60 s cadence), the
 * `metric_samples` snapshot (5 min), and the 60 s daemon refresh
 * (version + capabilities) so a single poller does all background PDNS work.
 */
async function runPollCycle({ full }: { full: boolean }): Promise<void> {
  const backends = await listAllActiveBackends();
  if (backends.length === 0) return;

  const now = Date.now();
  const sampledAt = new Date(now);
  const dueForStats = now - state.lastStatsSampleAt >= STATS_INTERVAL_MS;
  const dueForMetric = now - state.lastMetricSampleAt >= METRIC_SAMPLE_INTERVAL_MS;

  // IDLE (no subscribers): the only background work that should run is the
  // time-series sampling that backs the graphs — no zone diff, daemon refresh,
  // topology rebuild or advisory eval. A subscriber / page warm-up / mutation
  // restores the full cycle below.
  if (!full) {
    if (dueForStats) state.lastStatsSampleAt = now;
    if (dueForMetric) state.lastMetricSampleAt = now;
    if (dueForStats || dueForMetric) {
      await sampleTimeSeries(backends, { dueForStats, dueForMetric, sampledAt });
    }
    return;
  }

  // FULL cycle. The daemon refresh (version + capabilities + TSIG presence) keeps
  // its OWN 60 s clock so idle stats sampling, which advances lastStatsSampleAt,
  // can't starve it — the first full cycle after idle still re-probes promptly.
  const dueForDaemonRefresh = now - state.lastDaemonRefreshAt >= STATS_INTERVAL_MS;
  if (dueForStats) state.lastStatsSampleAt = now;
  if (dueForDaemonRefresh) state.lastDaemonRefreshAt = now;
  if (dueForMetric) state.lastMetricSampleAt = now;

  // Resolve every backend to its operator-facing slug. For primaries that's
  // the row's own slug; for a secondary that's its group's representative
  // primary's slug (ADR-0014). Operators view zones via the primary, so events
  // need to fan out to the primary's channel even when a secondary's poll
  // observed the change (e.g. AXFR caught up).
  const primarySlugByCluster = new Map<string, string>();
  for (const b of backends) {
    if (isWriteCapable(b.capabilities) && b.clusterId && !primarySlugByCluster.has(b.clusterId)) {
      primarySlugByCluster.set(b.clusterId, b.slug);
    }
  }
  const channelSlugById = new Map<string, string>();
  for (const b of backends) {
    if (isWriteCapable(b.capabilities)) {
      channelSlugById.set(b.id, b.slug);
    } else if (b.clusterId && primarySlugByCluster.has(b.clusterId)) {
      channelSlugById.set(b.id, primarySlugByCluster.get(b.clusterId)!);
    } else {
      channelSlugById.set(b.id, b.slug);
    }
  }

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
    authError: boolean; // true when the failure was a 401/403, not unreachable
    pendingEvents: Array<{ zoneName: string; channelSlug: string }>;
    // TSIG key names present on this backend, or null when not enumerated this
    // cycle (off-cadence, unsupported version, or the listing failed). Only the
    // daemon-refresh cadence populates it; consumed by the cross-backend
    // missing-key pass below.
    tsigKeyNames: string[] | null;
  }
  const pollResults: BackendPollResult[] = [];

  await Promise.all(
    backends.map(async (b) => {
      try {
        const client = getPdnsProbeClientForRow(b);
        const list = await client.listZones();
        recordBackendStatus(b.id, true, false);
        const snapshots: CachedZoneSnapshot[] = list.map((z) => ({
          id: z.id,
          name: z.name,
          serial: z.serial ?? null,
          editedSerial: z.edited_serial ?? null,
          notifiedSerial: z.notified_serial ?? null,
          kind: z.kind,
          dnssec: z.dnssec ?? false,
          masters: z.masters ?? [],
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
        const result: BackendPollResult = {
          backendId: b.id,
          snapshots,
          authError: false,
          pendingEvents,
          tsigKeyNames: null,
        };
        pollResults.push(result);

        // 60 s daemon refresh (ADR-0014): the shared probe re-reads version +
        // /config + /autoprimaries, persists them, and updates the in-memory row
        // so THIS cycle's topology + advisory computation use the fresh snapshot.
        // Same primitive the explicit Test path uses, so the two never diverge.
        if (dueForDaemonRefresh) {
          await probeDaemonMeta(client, b);

          // TSIG presence (ADR-0015 missing-key rule): enumerate the keys so the
          // post-loop cross-backend pass can flag a secondary missing a key its
          // primary replicated to the group. Version-gated; a failure just leaves
          // tsigKeyNames null (this backend is skipped, never falsely flagged).
          if (b.versionCache?.capabilities.supportsTsigApi) {
            try {
              result.tsigKeyNames = (await client.listTsigKeys()).map((k) => k.name);
            } catch (err) {
              logger.warn(
                { server: b.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
                "pdns.zone-poller.tsig-list.failed",
              );
            }
          }
        }

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
            statsRows.push(...statisticsToRows(await client.statistics(), b.id, sampledAt));
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
        // good state. Distinguish a 401/403 (daemon up, key/ACL
        // wrong) from a plain unreachable so the bell can advise
        // precisely (ADR-0015).
        const authError = err instanceof PdnsAuthError;
        recordBackendStatus(b.id, false, authError);
        pollResults.push({
          backendId: b.id,
          snapshots: null,
          authError,
          pendingEvents: [],
          tsigKeyNames: null,
        });
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

  // Recompute the site-wide derived topology (ADR-0014) once per cycle from
  // this poll's masters[] — pages read it from cache instead of re-deriving.
  await rebuildDerivedTopology(backends, pollResults);

  // Record reachability for every backend whose listZones() succeeded this
  // cycle. The Status badge + dashboard "stale backend" attention key off
  // `last_seen_at`, not `version_cache` (only the manual Test / Refresh-all
  // path moves that) — so healthy continuous polling keeps both green.
  const seenIds = pollResults.filter((r) => r.snapshots !== null).map((r) => r.backendId);
  if (seenIds.length > 0) {
    try {
      await markPdnsServersSeen(seenIds, sampledAt);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.mark-seen.failed",
      );
    }
  }

  // Replication state for this cycle (ADR-0014/0015): the set of mirror
  // backends with at least one zone not yet caught up to its primary. Drives
  // both the in-flight follow-up scheduling and the drift-duration tracking.
  const notSynced = computeNotSynced(backends);
  const driftMsById = updateDriftDurations(notSynced, now);

  // Cross-backend TSIG presence (ADR-0015 missing-key rule): only recomputed on
  // the daemon-refresh cadence (it needs every backend's key listing, gathered
  // above). Off-cadence cycles leave the last counts in place so the advisory
  // doesn't flap; the shared store lets the single-backend Test path read it too.
  if (dueForDaemonRefresh) {
    setTsigMissingCounts(
      await computeTsigMissing(
        backends,
        new Map(pollResults.map((r) => [r.backendId, r.tsigKeyNames])),
      ),
    );
  }
  const tsigMissingById = (id: string): number => getTsigMissingCount(id);

  // Recompute health advisories (ADR-0015) from this cycle's observed state,
  // then upsert/prune them. Reachability = whether listZones succeeded; zone
  // inventory = the snapshots; capabilities = the (possibly just-refreshed)
  // row; drift = the cross-backend duration computed above.
  const backendById = new Map(backends.map((b) => [b.id, b]));
  const advisoryChanges = await Promise.all(
    pollResults.map(async (r) => {
      const b = backendById.get(r.backendId);
      if (!b) return false;
      const zoneKinds: Record<string, number> = {};
      let mirrorZonesWithoutMasters = 0;
      for (const s of r.snapshots ?? []) {
        const k = s.kind.toLowerCase();
        zoneKinds[k] = (zoneKinds[k] ?? 0) + 1;
        if (MIRROR_KINDS.has(k) && s.masters.length === 0) mirrorZonesWithoutMasters += 1;
      }
      try {
        return await syncBackendAdvisories(
          b.id,
          evaluateBackendHealth({
            reachable: r.snapshots !== null,
            authError: r.authError,
            capabilities: b.capabilities,
            zoneKinds,
            mirrorZonesWithoutMasters,
            replicationDriftMs: driftMsById.get(b.id) ?? null,
            missingTransferKeys: tsigMissingById(b.id),
          }),
        );
      } catch (err) {
        logger.warn(
          { server: b.slug, err: err instanceof Error ? err.message : "unknown" },
          "pdns.zone-poller.advisory-sync.failed",
        );
        return false;
      }
    }),
  );
  // One nudge for the bell when the visible advisory set actually moved.
  if (advisoryChanges.some(Boolean)) publishHealthEvent();

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

  // One app-wide row per metric tick carries the active-session count
  // (`serverId = null`) — counted once here, never on the per-backend rows.
  if (dueForMetric) {
    const appWide = await appWideMetricRow(sampledAt);
    if (appWide) metricRows.push(appWide);
  }

  // Single-shot DB writes outside the per-backend Promise.all so a slow
  // insert doesn't block subsequent polls.
  await persistSamples(metricRows, statsRows);

  // If any expected-to-replicate zone is still mid-transfer, chain a quick
  // follow-up so we observe the catch-up and broadcast within seconds — not
  // 30 s on the next regular tick. Capped per sustained mismatch so a
  // permanently broken replica doesn't hot-loop the fleet forever; the
  // 30 s cadence keeps monitoring and the drift advisory fires past threshold.
  if (notSynced.size > 0) {
    if (state.consecutiveFollowups < MAX_CONSECUTIVE_FOLLOWUPS) {
      state.consecutiveFollowups += 1;
      scheduleFollowupPoll();
    }
  } else {
    state.consecutiveFollowups = 0;
  }
}

/** Flatten a `/statistics` response into `pdns_server_stats` insert rows. */
function statisticsToRows(
  stats: readonly PdnsStatisticsEntry[],
  serverId: string,
  ts: Date,
): Array<typeof pdnsServerStats.$inferInsert> {
  const rows: Array<typeof pdnsServerStats.$inferInsert> = [];
  for (const entry of stats) {
    if (entry.type === "StatisticItem") {
      const n = Number(entry.value);
      if (!Number.isFinite(n)) continue;
      rows.push({ ts, serverId, name: entry.name, value: n });
    } else if (entry.type === "MapStatisticItem") {
      rows.push({ ts, serverId, name: entry.name, mapValue: entry.value });
    }
  }
  return rows;
}

/**
 * Build the single app-wide metric row for this tick — `serverId = null`, with
 * only `activeSessions` populated (the backend-scoped fields stay null per the
 * schema's app-wide-row design). Active sessions are an app-wide quantity, so it
 * is counted ONCE per metric tick and written as one row — never duplicated
 * across the per-backend rows, which would pollute the series the dashboard
 * reads. Best-effort: a failed count just drops the app-wide row for this tick
 * rather than failing the whole sample (the next tick re-samples in 5 min).
 */
async function appWideMetricRow(
  sampledAt: Date,
): Promise<typeof metricSamples.$inferInsert | null> {
  try {
    return {
      serverId: null,
      sampledAt,
      zoneCount: null,
      latencyP50Ms: null,
      latencyP95Ms: null,
      activeSessions: await countActiveSessions(),
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "pdns.zone-poller.active-sessions.failed",
    );
    return null;
  }
}

/** Persist the cycle's time-series rows; chunked + best-effort (see callers). */
async function persistSamples(
  metricRows: ReadonlyArray<typeof metricSamples.$inferInsert>,
  statsRows: ReadonlyArray<typeof pdnsServerStats.$inferInsert>,
): Promise<void> {
  if (metricRows.length > 0) {
    try {
      await db.insert(metricSamples).values([...metricRows]);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.metric-samples.failed",
      );
    }
  }
  const CHUNK = 100;
  for (let i = 0; i < statsRows.length; i += CHUNK) {
    try {
      await db.insert(pdnsServerStats).values(statsRows.slice(i, i + CHUNK));
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.stats-insert.failed",
      );
      break;
    }
  }
}

/**
 * Idle (no-subscriber) path: sample ONLY the time-series that back the graphs —
 * `/statistics` (60 s) and the 5-min `metric_samples` snapshot. No zone diff,
 * daemon refresh, topology rebuild or advisory eval. The metric snapshot reuses
 * the cached zone count (no listZones) since nothing's refreshing the zone cache
 * while idle. A successful `/statistics` doubles as the reachability probe.
 */
async function sampleTimeSeries(
  backends: PdnsServer[],
  {
    dueForStats,
    dueForMetric,
    sampledAt,
  }: { dueForStats: boolean; dueForMetric: boolean; sampledAt: Date },
): Promise<void> {
  const metricRows: Array<typeof metricSamples.$inferInsert> = [];
  const statsRows: Array<typeof pdnsServerStats.$inferInsert> = [];
  const seenIds: string[] = [];

  await Promise.all(
    backends.map(async (b) => {
      const client = getPdnsProbeClientForRow(b);
      if (dueForStats) {
        try {
          statsRows.push(...statisticsToRows(await client.statistics(), b.id, sampledAt));
          recordBackendStatus(b.id, true, false);
          seenIds.push(b.id);
        } catch (err) {
          recordBackendStatus(b.id, false, err instanceof PdnsAuthError);
          logger.warn(
            { server: b.slug, err: err instanceof Error ? redact(err.message) : "unknown" },
            "pdns.zone-poller.idle-stats.failed",
          );
        }
      }
      if (dueForMetric) {
        const latency = drainPdnsLatency(b.slug);
        metricRows.push({
          serverId: b.id,
          sampledAt,
          zoneCount: readCachedZones(b.id)?.zones.size ?? 0,
          latencyP50Ms: latency?.p50 ?? null,
          latencyP95Ms: latency?.p95 ?? null,
          activeSessions: null,
        });
      }
    }),
  );

  // Keep last_seen_at fresh while idle so the status badge is green when the
  // operator returns — the /statistics hit already proved reachability.
  if (seenIds.length > 0) {
    try {
      await markPdnsServersSeen(seenIds, sampledAt);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.mark-seen.failed",
      );
    }
  }

  // The idle and full paths are mutually exclusive per tick (runPollCycle
  // returns after the idle branch), so emitting the single app-wide row here
  // too keeps the active-session series flowing while idle without ever
  // double-writing it within one tick.
  if (dueForMetric) {
    const appWide = await appWideMetricRow(sampledAt);
    if (appWide) metricRows.push(appWide);
  }
  await persistSamples(metricRows, statsRows);
}

/**
 * Cross-backend TSIG missing-key detection (ADR-0015). For each primary, the
 * "replicated set" is the keys present on the primary AND on at least one of its
 * secondaries — i.e. keys the operator actually pushed to the group (the install
 * flow pushes to all). A secondary missing any of those has drifted (the user's
 * test: deleting a replicated key off one secondary). Primary-only keys (never
 * replicated) aren't flagged, so a key kept solely on the primary is fine.
 *
 * `namesById` carries each backend's enumerated key names, or null when not
 * enumerated this cycle (unreachable / old version / listing failed) — a null
 * secondary is skipped, never falsely flagged.
 */
async function computeTsigMissing(
  backends: PdnsServer[],
  namesById: ReadonlyMap<string, string[] | null>,
): Promise<Map<string, number>> {
  const missing = new Map<string, number>();
  for (const primary of backends) {
    if (!isWriteCapable(primary.capabilities)) continue;
    const primaryNames = namesById.get(primary.id);
    if (!primaryNames || primaryNames.length === 0) continue;

    const secondaries = await listPrimarySecondaries(primary);
    if (secondaries.length === 0) continue;

    // A secondary can mirror more than one primary; accumulate across groups.
    const perGroup = missingReplicatedKeys(
      primaryNames,
      secondaries.map((s) => ({ id: s.id, names: namesById.get(s.id) ?? null })),
    );
    for (const [id, n] of perGroup) missing.set(id, (missing.get(id) ?? 0) + n);
  }
  return missing;
}

const MIRROR_KINDS = new Set(["slave", "secondary", "consumer"]);

/**
 * Recompute the site-wide derived topology (ADR-0014) from this cycle's
 * masters[]. Builds an `address → primary id` index from every write-target's
 * advertised addresses (DNS-resolved), then maps each mirror zone's masters[]
 * to its upstream primary in O(1). The result is cached for all surfaces — the
 * derive happens here, not per page render.
 */
async function rebuildDerivedTopology(
  backends: PdnsServer[],
  pollResults: ReadonlyArray<{ backendId: string; snapshots: CachedZoneSnapshot[] | null }>,
): Promise<void> {
  const addrToPrimary = new Map<string, string>();
  for (const b of backends) {
    if (!isWriteCapable(b.capabilities)) continue;
    for (const addr of await backendAddressSet(b)) {
      if (!addrToPrimary.has(addr)) addrToPrimary.set(addr, b.id);
    }
  }

  const mirrorsByPrimaryZone = new Map<string, Set<string>>();
  const parentVotes = new Map<string, Map<string, number>>();
  for (const r of pollResults) {
    if (r.snapshots === null) continue;
    for (const z of r.snapshots) {
      if (!MIRROR_KINDS.has(z.kind.toLowerCase()) || z.masters.length === 0) continue;
      const primaryId = await resolveMastersToBackendId(z.masters, addrToPrimary);
      if (!primaryId || primaryId === r.backendId) continue;
      const k = `${primaryId} ${z.name}`;
      (mirrorsByPrimaryZone.get(k) ?? mirrorsByPrimaryZone.set(k, new Set()).get(k)!).add(
        r.backendId,
      );
      const votes = parentVotes.get(r.backendId) ?? new Map<string, number>();
      votes.set(primaryId, (votes.get(primaryId) ?? 0) + 1);
      parentVotes.set(r.backendId, votes);
    }
  }

  // A secondary's representative parent = the primary most of its zones mirror.
  const parentBySecondary = new Map<string, string>();
  for (const [secId, votes] of parentVotes) {
    let best: string | null = null;
    let bestN = 0;
    for (const [pid, n] of votes) {
      if (n > bestN) {
        best = pid;
        bestN = n;
      }
    }
    if (best) parentBySecondary.set(secId, best);
  }

  writeDerivedTopology({ mirrorsByPrimaryZone, parentBySecondary, computedAt: Date.now() });
}

/**
 * Mirror backends with at least one expected-to-replicate zone NOT yet caught
 * up to its primary's serial — via EITHER explicit group membership OR the
 * site-wide derived (masters[]-based) topology. Native zones aren't AXFR'd, so
 * a Native missing on the secondary is fine; only Master/Primary zones count
 * (else any primary hosting a Native would chain follow-ups forever).
 */
function computeNotSynced(
  backends: ReadonlyArray<{
    id: string;
    capabilities: PdnsDaemonCapabilities | null;
    clusterId: string | null;
  }>,
): Set<string> {
  const out = new Set<string>();
  const isReplicatingPrimaryKind = (kind: string): boolean =>
    kind === "Master" || kind === "Primary";

  // 1. Explicit group edges: a mirror's primary is its group's representative
  //    write target.
  const primaryByCluster = new Map<string, string>();
  for (const b of backends) {
    if (isWriteCapable(b.capabilities) && b.clusterId && !primaryByCluster.has(b.clusterId)) {
      primaryByCluster.set(b.clusterId, b.id);
    }
  }
  for (const s of backends) {
    if (!isReadOnlyMirror(s.capabilities) || !s.clusterId) continue;
    const primaryId = primaryByCluster.get(s.clusterId);
    if (!primaryId) continue;
    const primaryEntry = readCachedZones(primaryId);
    const secondaryEntry = readCachedZones(s.id);
    if (!primaryEntry || !secondaryEntry) continue;
    for (const [zoneName, primarySnap] of primaryEntry.zones) {
      if (!isReplicatingPrimaryKind(primarySnap.kind)) continue;
      // A missing zone on the secondary (undefined) is also "not synced".
      const secondarySnap = secondaryEntry.zones.get(zoneName);
      if (secondarySnap?.serial !== primarySnap.serial) {
        out.add(s.id);
        break;
      }
    }
  }

  // 2. Derived (ungrouped) edges from the site-wide topology cache: an
  //    ungrouped secondary auto-derived from masters[] has no clusterId, so the
  //    group loop skips it. Rebuilt earlier this same cycle.
  for (const [k, secIds] of rawDerivedTopology().mirrorsByPrimaryZone) {
    const sp = k.indexOf(" ");
    if (sp < 0) continue;
    const primaryId = k.slice(0, sp);
    const zoneName = k.slice(sp + 1);
    const primarySnap = readCachedZones(primaryId)?.zones.get(zoneName);
    if (!primarySnap || !isReplicatingPrimaryKind(primarySnap.kind)) continue;
    for (const secId of secIds) {
      const secondarySnap = readCachedZones(secId)?.zones.get(zoneName);
      if (secondarySnap?.serial !== primarySnap.serial) out.add(secId);
    }
  }

  return out;
}

let followupPollPending = false;
function scheduleFollowupPoll(): void {
  // PDNS_BACKGROUND_POLLING=false → no follow-up cycle to observe AXFR catch-up.
  // There is no replication topology we surface in this mode, so the in-flight
  // tracking is moot. The next operator-initiated page render warms what it
  // needs via `ensureBackendsObserved`.
  if (!pdnsBackgroundPollingEnabled) return;
  if (followupPollPending) return;
  followupPollPending = true;
  setTimeout(() => {
    followupPollPending = false;
    // A follow-up exists to observe an in-flight AXFR catching up — inherently a
    // full-cycle concern (zone serials + drift), so never stats-only.
    void withRequestId(newSystemRequestId(), () => pollOnce({ full: true })).catch((err) => {
      logger.warn(
        { err: err instanceof Error ? err.message : "unknown" },
        "pdns.zone-poller.followup.failed",
      );
    });
  }, IN_FLIGHT_FOLLOWUP_MS);
}
