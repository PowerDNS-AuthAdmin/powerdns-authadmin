/**
 * lib/monitoring/zone-monitor.ts
 *
 * Background zone monitoring: once per interval, every hosted zone is checked
 * from the outside - the parent's delegation (walked from the root servers),
 * each nameserver's answers (reachable, authoritative, serial, NS set, open
 * AXFR), the DNSSEC chain (DS at the parent vs DNSKEY), the view of public or
 * internal resolvers, and the reverse-DNS tally - and the findings are kept
 * in memory for the Zone Monitoring page and mirrored into the advisories
 * table for the bell and the sidebar counts.
 *
 * Horizon-aware: a public zone is judged against the internet (root walk,
 * public resolvers, private nameserver addresses are a finding); an internal
 * zone is judged against its own nameservers and the configured internal
 * resolvers only.
 *
 * Load discipline: one scan of the fleet (shared with the Reverse DNS page),
 * zones probed a few at a time and spaced across the cycle, every query
 * bounded by a timeout, nothing retried in a loop. A host with no outbound
 * DNS degrades to "unverified" notes, never to a wall of errors.
 *
 * Why in-process memory rather than a table: results are derived state that
 * the next cycle recomputes; the durable part (advisories) already has a table.
 */

import "server-only";
import { promises as dns } from "node:dns";
import type { PdnsServer } from "@/lib/db/schema";
import { listAllActiveBackends } from "@/lib/db/repositories/pdns-servers";
import {
  deleteAdvisoriesWithPrefix,
  syncBackendAdvisories,
} from "@/lib/db/repositories/backend-advisories";
import { findDelegation, type DelegationResult } from "@/lib/dns/delegation";
import { reconcilePtrs } from "@/lib/dns/ptr-reconcile";
import { rootAddresses } from "@/lib/dns/root-hints";
import { probeAxfr, query, type WireMessage } from "@/lib/dns/wire";
import {
  evaluateZone,
  worstSeverity,
  type FindingSeverity,
  type NameserverObservation,
  type NameserverProbe,
  type ResolverObservation,
  type ZoneFinding,
  type ZoneProbeData,
} from "@/lib/dns/zone-checks";
import type { ZoneHorizon } from "@/lib/dns/zone-horizon";
import { optionalFeatures, zoneMonitorConfig } from "@/lib/env";
import type { EvaluatedAdvisory } from "@/lib/health/evaluator";
import { logger } from "@/lib/logger";
import { classifyAddress } from "@/lib/net/url-safety";
import { publishHealthEvent, publishMonitorEvent } from "@/lib/realtime/event-bus";
import { newSystemRequestId, withRequestId } from "@/lib/request-context";
import { getFleetScan, type ScannedZone } from "@/app/api/admin/pdns/auto-ptr/_scan";

export const MONITOR_ADVISORY_PREFIX = "monitor.";

export interface ZoneMonitorResult {
  zone: string;
  server: string;
  horizon: ZoneHorizon;
  checkedAt: string;
  durationMs: number;
  severity: FindingSeverity | null;
  findings: ZoneFinding[];
  summary: {
    delegation: DelegationResult["status"] | "skipped";
    parentNameservers: string[];
    apexNameservers: string[];
    nameservers: Array<{
      name: string;
      addresses: string[];
      serials: Array<number | null>;
      authoritative: boolean | null;
    }>;
    resolvers: Array<{
      address: string;
      kind: "public" | "internal";
      rcode: string | null;
      serial: number | null;
    }>;
    dnssec: { signed: boolean; dsAtParent: number; dnskeys: number };
    reverse: { addresses: number; missing: number; mismatch: number } | null;
    serial: number | null;
  };
}

export interface ZoneMonitorState {
  enabled: boolean;
  intervalMs: number;
  lastCycleAt: string | null;
  nextCycleAt: string | null;
  running: boolean;
  /** True when the last cycle could not reach any root server. */
  offline: boolean;
  results: ZoneMonitorResult[];
  counts: { zones: number; error: number; warn: number; info: number; ok: number };
}

interface State {
  timer: NodeJS.Timeout | null;
  inFlight: Promise<void> | null;
  results: Map<string, ZoneMonitorResult>;
  lastCycleAt: number;
  nextCycleAt: number;
  lastManualAt: number;
  offline: boolean;
  perZoneRefreshAt: Map<string, number>;
  /** Reverse DNS rows needing attention after the last cycle (missing, mismatch, ambiguous, orphan). */
  reverseNotOk: number;
  /** Debounce for "zones without a result yet, check them now". */
  catchUp: NodeJS.Timeout | null;
}

declare global {
  var __zoneMonitor: State | undefined;
}
const state: State = (globalThis.__zoneMonitor ??= {
  timer: null,
  inFlight: null,
  results: new Map(),
  lastCycleAt: 0,
  nextCycleAt: 0,
  lastManualAt: 0,
  offline: false,
  perZoneRefreshAt: new Map(),
  reverseNotOk: 0,
  catchUp: null,
});

const ZONE_CONCURRENCY = 3;
const QUERY_TIMEOUT_MS = 3000;
const FIRST_CYCLE_DELAY_MS = 15_000;
export const MANUAL_REFRESH_INTERVAL_MS = 60_000;
const PER_ZONE_REFRESH_INTERVAL_MS = 20_000;

const key = (zone: string, server: string): string => `${server}|${zone}`;

/* ------------------------------------------------------------------ probes */

async function resolveAddresses(name: string): Promise<string[]> {
  try {
    const all = await dns.lookup(name, { all: true, verbatim: true });
    return all.map((a) => a.address);
  } catch {
    return [];
  }
}

async function isCname(name: string): Promise<boolean> {
  try {
    const targets = await dns.resolveCname(name);
    return targets.length > 0;
  } catch {
    return false;
  }
}

async function soaProbe(zone: string, address: string, recursion: boolean): Promise<WireMessage> {
  return query(zone, "SOA", { server: address, recursion, timeoutMs: QUERY_TIMEOUT_MS });
}

function serialOf(zone: string, msg: WireMessage): number | null {
  const soa = msg.answer.find((r) => r.type === "SOA" && r.name === zone)?.soa;
  return soa ? soa.serial : null;
}

async function probeNameserver(
  z: ScannedZone,
  name: string,
  delegationGlue: Record<string, string[]>,
  probePrivate: boolean,
): Promise<NameserverObservation> {
  let addresses = z.glue[name] ?? delegationGlue[name] ?? [];
  if (addresses.length === 0) addresses = await resolveAddresses(name);
  addresses = [...new Set(addresses)];
  const privateAddresses = addresses.filter((a) => classifyAddress(a) !== "ok");
  const probes: NameserverProbe[] = [];
  // At most two addresses per nameserver: an anycast service may publish many,
  // and two already tell "down" from "one address down".
  const targets = addresses.filter((a) => probePrivate || classifyAddress(a) === "ok").slice(0, 2);
  for (const address of targets) {
    try {
      const soa = await soaProbe(z.name, address, false);
      const probe: NameserverProbe = {
        address,
        ok: true,
        aa: soa.aa,
        rcodeName: soa.rcodeName,
        serial: serialOf(z.name, soa),
      };
      if (soa.aa && soa.rcode === 0) {
        try {
          const ns = await query(z.name, "NS", { server: address, timeoutMs: QUERY_TIMEOUT_MS });
          probe.nsSet = ns.answer
            .filter((r) => r.type === "NS" && r.name === z.name)
            .map((r) => r.data);
        } catch {
          // the SOA already proved the server answers; a lost NS query is not a finding
        }
        probe.axfr = await probeAxfr(z.name, { server: address, timeoutMs: QUERY_TIMEOUT_MS });
      }
      probes.push(probe);
    } catch (err) {
      probes.push({ address, ok: false, error: err instanceof Error ? err.message : "unknown" });
    }
  }
  return { name, addresses, privateAddresses, isCname: await isCname(name), probes };
}

async function probeResolver(
  zone: string,
  address: string,
  kind: "public" | "internal",
): Promise<ResolverObservation> {
  try {
    const msg = await soaProbe(zone, address, true);
    return { address, kind, ok: true, rcodeName: msg.rcodeName, serial: serialOf(zone, msg) };
  } catch (err) {
    return { address, kind, ok: false, error: err instanceof Error ? err.message : "unknown" };
  }
}

async function dnskeysFrom(
  zone: string,
  address: string,
): Promise<Array<{ keyTag: number; algorithm: number }>> {
  try {
    const msg = await query(zone, "DNSKEY", {
      server: address,
      dnssec: true,
      timeoutMs: QUERY_TIMEOUT_MS,
    });
    return msg.answer
      .filter((r) => r.type === "DNSKEY" && r.dnskey)
      .map((r) => ({ keyTag: r.dnskey!.keyTag, algorithm: r.dnskey!.algorithm }));
  } catch {
    return [];
  }
}

interface ProbeContext {
  roots: string[];
  rootsReachable: boolean;
  reverse: Map<string, { addresses: number; missing: number; mismatch: number }>;
}

async function probeZone(z: ScannedZone, ctx: ProbeContext): Promise<ZoneMonitorResult> {
  const started = Date.now();
  const isPublic = z.horizon === "public";
  let delegation: DelegationResult | null = null;
  if (isPublic && ctx.rootsReachable) {
    delegation = await findDelegation(z.name, {
      rootServers: ctx.roots,
      query: (name, type, server) => query(name, type, { server, timeoutMs: QUERY_TIMEOUT_MS }),
      lookup: resolveAddresses,
    });
  } else if (isPublic) {
    delegation = {
      zone: z.name,
      status: "unreachable",
      nameservers: [],
      glue: {},
      ds: [],
      parentServers: [],
      path: ["."],
      error: "no root server answered",
    };
  }
  // A public zone on a host with no path to the root servers cannot be judged
  // from the outside at all: probing its nameservers would only turn the same
  // blocked egress into "unreachable" errors, so the zone gets one unverified
  // note instead. Internal zones are still probed; their nameservers are on the
  // network the host can see.
  const probeOutside = !isPublic || ctx.rootsReachable;
  const nameservers: NameserverObservation[] = [];
  if (probeOutside) {
    for (const name of z.nsNames) {
      nameservers.push(await probeNameserver(z, name, delegation?.glue ?? {}, !isPublic));
    }
  }
  const resolverList = !probeOutside
    ? []
    : isPublic
      ? zoneMonitorConfig.publicResolvers
      : zoneMonitorConfig.internalResolvers;
  const resolvers = await Promise.all(
    resolverList.map((r) => probeResolver(z.name, r, isPublic ? "public" : "internal")),
  );
  const authoritative = nameservers
    .flatMap((n) => n.probes)
    .find((p) => p.ok && p.aa && p.rcodeName === "NOERROR");
  const dnskeys = z.dnssec && authoritative ? await dnskeysFrom(z.name, authoritative.address) : [];
  const data: ZoneProbeData = {
    zone: z.name,
    horizon: z.horizon,
    pdns: { serial: z.serial, soa: z.soa, nsNames: z.nsNames, dnskeys, glue: z.glue },
    delegation,
    nameservers,
    resolvers,
    reverse: ctx.reverse.get(key(z.name, z.server)) ?? null,
  };
  const findings = evaluateZone(data);
  return {
    zone: z.name,
    server: z.server,
    horizon: z.horizon,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    severity: worstSeverity(findings),
    findings,
    summary: {
      delegation: delegation?.status ?? "skipped",
      parentNameservers: delegation?.nameservers ?? [],
      apexNameservers: z.nsNames,
      nameservers: nameservers.map((n) => ({
        name: n.name,
        addresses: n.addresses,
        serials: n.probes.map((p) => p.serial ?? null),
        authoritative: n.probes.length ? n.probes.every((p) => p.ok && p.aa === true) : null,
      })),
      resolvers: resolvers.map((r) => ({
        address: r.address,
        kind: r.kind,
        rcode: r.rcodeName ?? null,
        serial: r.serial ?? null,
      })),
      dnssec: { signed: z.dnssec, dsAtParent: delegation?.ds.length ?? 0, dnskeys: dnskeys.length },
      reverse: data.reverse ?? null,
      serial: z.serial,
    },
  };
}

/** One query to the roots decides whether delegation walks are worth trying this cycle. */
async function rootsReachable(roots: string[]): Promise<boolean> {
  for (const root of roots.slice(0, 3)) {
    try {
      await query(".", "NS", { server: root, timeoutMs: 2500 });
      return true;
    } catch {
      // next root
    }
  }
  return false;
}

function reverseTallies(scan: Awaited<ReturnType<typeof getFleetScan>>): ProbeContext["reverse"] {
  // The reverse-DNS drift finding and the Reverse DNS sidebar count belong to
  // the Reverse DNS checks, which are opt-in on their own.
  if (!optionalFeatures.reverseDns) {
    state.reverseNotOk = 0;
    return new Map();
  }
  const { rows } = reconcilePtrs({
    forward: scan.forward,
    reverse: scan.reverse,
    hostedReverseZones: scan.hostedReverseZones,
    canWriteReverse: () => true,
  });
  state.reverseNotOk = rows.filter((r) => r.status !== "ok" && r.status !== "unhosted").length;
  const out = new Map<string, { addresses: number; missing: number; mismatch: number }>();
  for (const row of rows) {
    for (const f of row.forward) {
      const k = key(f.zone, f.server);
      const t = out.get(k) ?? { addresses: 0, missing: 0, mismatch: 0 };
      t.addresses++;
      if (row.status === "missing") t.missing++;
      if (row.status === "mismatch") t.mismatch++;
      out.set(k, t);
    }
  }
  return out;
}

/* ------------------------------------------------------------- advisories */

function advisoriesFor(results: readonly ZoneMonitorResult[]): EvaluatedAdvisory[] {
  const byCode = new Map<string, EvaluatedAdvisory>();
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity === "info") continue;
      const code = `${MONITOR_ADVISORY_PREFIX}${r.zone}.${f.code}`;
      const prev = byCode.get(code);
      if (prev) {
        if (!prev.detail.includes(f.detail)) prev.detail = `${prev.detail} ${f.detail}`;
        continue;
      }
      byCode.set(code, {
        code,
        severity: f.severity,
        // A split-horizon zone has two results under one name; say which copy.
        title:
          r.horizon === "internal" ? `${r.zone} (internal) ${f.title}` : `${r.zone} ${f.title}`,
        detail: f.detail,
      });
    }
  }
  return [...byCode.values()];
}

async function syncAdvisories(
  results: readonly ZoneMonitorResult[],
  servers: readonly PdnsServer[],
  immediate: boolean,
): Promise<void> {
  const bySlug = new Map(servers.map((s) => [s.slug, s]));
  const grouped = new Map<string, ZoneMonitorResult[]>();
  for (const r of results)
    (grouped.get(r.server) ?? grouped.set(r.server, []).get(r.server)!).push(r);
  let changed = false;
  for (const [slug, list] of grouped) {
    const server = bySlug.get(slug);
    if (!server) continue;
    try {
      changed =
        (await syncBackendAdvisories(server.id, advisoriesFor(list), {
          immediate,
          codePrefix: MONITOR_ADVISORY_PREFIX,
        })) || changed;
    } catch (err) {
      logger.warn(
        { server: slug, error: err instanceof Error ? err.message : "unknown" },
        "zone-monitor.advisories.failed",
      );
    }
  }
  if (changed) publishHealthEvent();
}

/* ----------------------------------------------------------------- cycles */

async function runCycle(opts: {
  immediate: boolean;
  only?: ReadonlyArray<{ zone: string; server: string }>;
}): Promise<void> {
  const scan = await getFleetScan({ maxAgeMs: zoneMonitorConfig.intervalMs });
  const roots = rootAddresses();
  const reachable = scan.zones.some((z) => z.horizon === "public")
    ? await rootsReachable(roots)
    : true;
  state.offline = !reachable;
  const ctx: ProbeContext = { roots, rootsReachable: reachable, reverse: reverseTallies(scan) };
  const seen = new Set<string>();
  const dedup = new Map<string, ScannedZone>();
  for (const z of scan.zones)
    if (!dedup.has(key(z.name, z.server))) dedup.set(key(z.name, z.server), z);
  const onlyKeys = opts.only ? new Set(opts.only.map((o) => key(o.zone, o.server))) : null;
  const zones = [...dedup.values()].filter((z) => !onlyKeys || onlyKeys.has(key(z.name, z.server)));

  // Spread the probes across the cycle instead of hammering every nameserver at once.
  const spacingMs = opts.only
    ? 0
    : Math.min(10_000, (zoneMonitorConfig.intervalMs * 0.6) / Math.max(1, zones.length));
  let next = 0;
  const results: ZoneMonitorResult[] = [];
  const workers = Array.from({ length: Math.min(ZONE_CONCURRENCY, zones.length) }, async () => {
    while (next < zones.length) {
      const z = zones[next++]!;
      try {
        const result = await probeZone(z, ctx);
        state.results.set(key(z.name, z.server), result);
        seen.add(key(z.name, z.server));
        results.push(result);
      } catch (err) {
        logger.warn(
          { zone: z.name, error: err instanceof Error ? err.message : "unknown" },
          "zone-monitor.zone.failed",
        );
      }
      if (spacingMs > 0) await new Promise((r) => setTimeout(r, spacingMs));
    }
  });
  await Promise.all(workers);
  if (!opts.only) {
    for (const k of [...state.results.keys()]) if (!seen.has(k)) state.results.delete(k);
    state.lastCycleAt = Date.now();
    state.nextCycleAt = Date.now() + zoneMonitorConfig.intervalMs;
  }
  await syncAdvisories(
    opts.only ? [...state.results.values()] : results,
    scan.servers,
    opts.immediate,
  );
  publishMonitorEvent("zone-monitor");
}

function cycle(opts: {
  immediate: boolean;
  only?: ReadonlyArray<{ zone: string; server: string }>;
}): Promise<void> {
  if (state.inFlight) return state.inFlight;
  state.inFlight = withRequestId(newSystemRequestId(), () => runCycle(opts))
    .catch((err) => {
      logger.warn(
        { error: err instanceof Error ? err.message : "unknown" },
        "zone-monitor.cycle.failed",
      );
    })
    .finally(() => {
      state.inFlight = null;
    });
  return state.inFlight;
}

declare global {
  var __zoneMonitorPurged: boolean | undefined;
}

/**
 * With monitoring switched off, findings from when it was on would otherwise
 * stay in the bell forever (nothing runs to clear them). Remove them once per
 * process.
 */
function purgeStaleAdvisoriesOnce(): void {
  if (globalThis.__zoneMonitorPurged) return;
  globalThis.__zoneMonitorPurged = true;
  deleteAdvisoriesWithPrefix(MONITOR_ADVISORY_PREFIX)
    .then((removed) => {
      if (removed > 0) {
        logger.info({ removed }, "zone-monitor.disabled.advisories-cleared");
        publishHealthEvent();
      }
    })
    .catch((err: unknown) => {
      globalThis.__zoneMonitorPurged = false;
      logger.warn(
        { error: err instanceof Error ? err.message : "unknown" },
        "zone-monitor.disabled.purge-failed",
      );
    });
}

/** Start the periodic monitor (idempotent). Called from the app shell. */
export function ensureZoneMonitorRunning(): void {
  if (!zoneMonitorConfig.enabled) {
    purgeStaleAdvisoriesOnce();
    return;
  }
  if (state.timer) return;
  state.timer = setInterval(() => void cycle({ immediate: false }), zoneMonitorConfig.intervalMs);
  state.nextCycleAt = Date.now() + FIRST_CYCLE_DELAY_MS;
  setTimeout(() => void cycle({ immediate: false }), FIRST_CYCLE_DELAY_MS);
}

/**
 * Operator-triggered full run. Rate-limited: a reload-happy tab must not turn
 * every nameserver on the internet into a target. Returns false when refused.
 */
export async function refreshAllZones(): Promise<boolean> {
  if (!zoneMonitorConfig.enabled) return false;
  if (Date.now() - state.lastManualAt < MANUAL_REFRESH_INTERVAL_MS) return false;
  state.lastManualAt = Date.now();
  await cycle({ immediate: true });
  return true;
}

/** Operator-triggered re-check of one zone (immediate advisories). */
export async function refreshZone(
  zone: string,
  server: string,
): Promise<ZoneMonitorResult | null | false> {
  if (!zoneMonitorConfig.enabled) return false;
  const k = key(zone, server);
  if (Date.now() - (state.perZoneRefreshAt.get(k) ?? 0) < PER_ZONE_REFRESH_INTERVAL_MS)
    return false;
  state.perZoneRefreshAt.set(k, Date.now());
  await cycle({ immediate: true, only: [{ zone, server }] });
  return state.results.get(k) ?? null;
}

/**
 * Zones the fleet scan knows but the monitor has no result for yet (a fresh
 * install, a zone created a moment ago) are checked within seconds of a page
 * asking, instead of waiting for the next scheduled cycle. Debounced so one
 * page render triggers one catch-up; the per-zone and full-run rate limits
 * do not apply because nothing was probed before.
 */
export function ensureNewZonesProbed(
  scanZones: ReadonlyArray<{ name: string; server: string }>,
): void {
  if (!zoneMonitorConfig.enabled || state.catchUp) return;
  const missing = scanZones
    .filter((z) => !state.results.has(key(z.name, z.server)))
    .map((z) => ({ zone: z.name, server: z.server }));
  if (missing.length === 0) return;
  state.catchUp = setTimeout(() => {
    state.catchUp = null;
    void cycle({ immediate: true, only: missing });
  }, 2_000);
}

export function getZoneMonitorState(): ZoneMonitorState {
  const results = [...state.results.values()].sort((a, b) => {
    const order = { error: 0, warn: 1, info: 2 };
    const sa = a.severity ? order[a.severity] : 3;
    const sb = b.severity ? order[b.severity] : 3;
    return sa - sb || a.zone.localeCompare(b.zone);
  });
  const counts = { zones: results.length, error: 0, warn: 0, info: 0, ok: 0 };
  for (const r of results) counts[r.severity ?? "ok"]++;
  return {
    enabled: zoneMonitorConfig.enabled,
    intervalMs: zoneMonitorConfig.intervalMs,
    lastCycleAt: state.lastCycleAt ? new Date(state.lastCycleAt).toISOString() : null,
    nextCycleAt: state.nextCycleAt ? new Date(state.nextCycleAt).toISOString() : null,
    running: state.inFlight !== null,
    offline: state.offline,
    results,
    counts,
  };
}

/** Reverse DNS rows needing attention, from the last cycle's scan; no I/O. */
export function reverseDnsBadge(): number {
  return state.reverseNotOk;
}

/** Cheap counts for the sidebar badges; no I/O. */
export function zoneMonitorBadge(): { problems: number; tone: "error" | "warn" } {
  let error = 0;
  let warn = 0;
  for (const r of state.results.values()) {
    if (r.severity === "error") error++;
    else if (r.severity === "warn") warn++;
  }
  return { problems: error + warn, tone: error > 0 ? "error" : "warn" };
}

export async function activeBackendsForMonitor(): Promise<PdnsServer[]> {
  return listAllActiveBackends();
}
