/**
 * lib/search/search-index.ts
 *
 * The prebuilt search index. Reading the sources (the fleet scan, the app
 * database, the settings) is the slow part of a search, so it happens here,
 * in the background, and never on a keystroke: a query is permission
 * filtering and fuzzy scoring over data already in memory.
 *
 * Hot swap. `current` is always a complete, immutable snapshot. A rebuild
 * reads everything into a new snapshot and replaces `current` in one
 * assignment, so a query in flight finishes against the snapshot it started
 * with and the next one sees the new data; nothing ever serves a half-built
 * index. A failed build keeps the previous snapshot.
 *
 * Freshness. Zone, audit and request-log events mark the index stale; a
 * short debounce folds a burst of changes into one build. Settings, users,
 * teams, roles, templates and providers are all audited, so the audit event
 * covers them. After each swap `search.index.updated` goes out on the
 * realtime bus and an open search palette re-runs its query. A slow
 * periodic rebuild covers anything that changed without an event (an edit
 * made directly on a PowerDNS backend, picked up by the scan).
 */

import "server-only";
import { logger } from "@/lib/logger";
import { publishSearchIndexEvent, subscribeAll } from "@/lib/realtime/event-bus";
import type { RealtimeEvent } from "@/lib/realtime/event-bus";
import type { SearchSources } from "./index";

type Resolved<T> = T extends () => Promise<infer R> ? R : never;
type SnapshotData = { [K in keyof SearchSources]: Resolved<SearchSources[K]> };

export interface SearchSnapshot {
  version: number;
  builtAt: number;
  buildMs: number;
  data: SnapshotData;
}

/** Changes arriving within this window share one rebuild. */
const DEBOUNCE_MS = 750;
/** The request log changes on every PowerDNS call; rebuild for it at most this often. */
const LOG_ONLY_MIN_INTERVAL_MS = 15_000;
/** Catch-all rebuild for changes no event announces. */
const PERIODIC_MS = 5 * 60_000;

interface IndexState {
  current: SearchSnapshot | null;
  building: Promise<SearchSnapshot | null> | null;
  /** A change arrived while a build was running: build again when it ends. */
  rerun: boolean;
  timer: NodeJS.Timeout | null;
  /** When the scheduled rebuild fires (epoch ms); 0 when none is scheduled. */
  timerDueAt?: number;
  periodic: NodeJS.Timeout | null;
  unsubscribe: (() => void) | null;
  lastBuildStartedAt: number;
  sources: SearchSources | null;
}

declare global {
  var __searchIndex: IndexState | undefined;
}
const state: IndexState = (globalThis.__searchIndex ??= {
  current: null,
  building: null,
  rerun: false,
  timer: null,
  periodic: null,
  unsubscribe: null,
  lastBuildStartedAt: 0,
  sources: null,
});

async function loadSources(): Promise<SearchSources> {
  state.sources ??= (await import("./sources")).defaultSearchSources;
  return state.sources;
}

async function readAll(sources: SearchSources): Promise<SnapshotData> {
  const [
    zones,
    records,
    settings,
    backends,
    clusters,
    users,
    teams,
    roles,
    templates,
    authProviders,
    requests,
    audit,
  ] = await Promise.all([
    sources.zones(),
    sources.records(),
    sources.settings(),
    sources.backends(),
    sources.clusters(),
    sources.users(),
    sources.teams(),
    sources.roles(),
    sources.templates(),
    sources.authProviders(),
    sources.requests(),
    sources.audit(),
  ]);
  return {
    zones,
    records,
    settings,
    backends,
    clusters,
    users,
    teams,
    roles,
    templates,
    authProviders,
    requests,
    audit,
  };
}

function build(): Promise<SearchSnapshot | null> {
  if (state.building) {
    state.rerun = true;
    return state.building;
  }
  state.lastBuildStartedAt = Date.now();
  const started = performance.now();
  state.building = loadSources()
    .then(readAll)
    .then((data) => {
      const snapshot: SearchSnapshot = {
        version: (state.current?.version ?? 0) + 1,
        builtAt: Date.now(),
        buildMs: Math.round(performance.now() - started),
        data,
      };
      state.current = snapshot; // the swap
      publishSearchIndexEvent(snapshot.version);
      return snapshot;
    })
    .catch((err: unknown) => {
      logger.warn(
        { error: err instanceof Error ? err.message : "unknown" },
        "search.index.build.failed",
      );
      return state.current;
    })
    .finally(() => {
      state.building = null;
      if (state.rerun) {
        state.rerun = false;
        schedule(DEBOUNCE_MS);
      }
    });
  return state.building;
}

function schedule(delayMs: number): void {
  // The earliest deadline wins: a zone change must not wait behind a slower
  // rebuild already queued for request-log churn.
  const dueAt = Date.now() + delayMs;
  if (state.timer && (state.timerDueAt ?? 0) <= dueAt) return;
  if (state.timer) clearTimeout(state.timer);
  state.timerDueAt = dueAt;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.timerDueAt = 0;
    void build();
  }, delayMs);
}

function onEvent(event: RealtimeEvent): void {
  if (event.type === "zone.updated" || event.type === "audit.appended") {
    schedule(DEBOUNCE_MS);
  } else if (event.type === "pdns.request.appended") {
    const since = Date.now() - state.lastBuildStartedAt;
    schedule(Math.max(DEBOUNCE_MS, LOG_ONLY_MIN_INTERVAL_MS - since));
  }
}

function ensureWatching(): void {
  state.unsubscribe ??= subscribeAll(onEvent);
  state.periodic ??= setInterval(() => void build(), PERIODIC_MS);
}

/**
 * The snapshot to answer a query with. Never waits for a rebuild once a first
 * snapshot exists; only the very first query after boot waits for the first
 * build.
 */
export async function getSearchSnapshot(): Promise<SearchSnapshot> {
  ensureWatching();
  if (state.current) return state.current;
  const first = await build();
  if (!first) throw new Error("The search index is not available yet.");
  return first;
}

/** The snapshot as a SearchSources, so the matcher reads it like live sources. */
export function snapshotSources(snapshot: SearchSnapshot): SearchSources {
  const d = snapshot.data;
  return {
    zones: () => Promise.resolve(d.zones),
    records: () => Promise.resolve(d.records),
    settings: () => Promise.resolve(d.settings),
    backends: () => Promise.resolve(d.backends),
    clusters: () => Promise.resolve(d.clusters),
    users: () => Promise.resolve(d.users),
    teams: () => Promise.resolve(d.teams),
    roles: () => Promise.resolve(d.roles),
    templates: () => Promise.resolve(d.templates),
    authProviders: () => Promise.resolve(d.authProviders),
    requests: () => Promise.resolve(d.requests),
    audit: () => Promise.resolve(d.audit),
  };
}

/** Start building at boot so the first search does not pay for it. */
export function warmSearchIndex(): void {
  ensureWatching();
  if (!state.current && !state.building) void build();
}

/** Tests: replace the sources and drop the snapshot. */
export function resetSearchIndexForTests(sources: SearchSources | null): void {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.current = null;
  state.building = null;
  state.rerun = false;
  state.sources = sources;
}

/** Tests: run a rebuild now and wait for the swap. */
export async function rebuildSearchIndexNow(): Promise<SearchSnapshot | null> {
  return build();
}
