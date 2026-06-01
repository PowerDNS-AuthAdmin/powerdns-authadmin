/**
 * lib/pdns/sync.ts
 *
 * Helpers to compare a zone's state across a primary and its secondaries
 * - used by the zones list (compact "in-sync / lagging" column) and the
 * zone detail page (rrset diff panel).
 *
 * All probes run concurrently; per-secondary errors are caught and
 * surfaced as `state="error"` so one unreachable mirror doesn't break
 * the rest of the view.
 */

/* eslint-disable no-restricted-imports -- Sanctioned lib/pdns→lib/db bridge:
   this module is cross-server zone-state coordination - it enumerates a
   primary's active secondaries (a DB read) and fans probes across them. See
   ADR-0013. Future work: relocate above lib/pdns (e.g. a lib/cluster/ module). */
import "server-only";
import {
  listAllActiveBackends,
  listSecondariesForPrimary,
} from "@/lib/db/repositories/pdns-servers";
import { canonicalTxtContent } from "@/lib/dns/txt";
import { getBackendGateway } from "@/lib/realtime/backend-gateway";
import { readCachedZone, readCachedZones } from "@/lib/pdns/zone-state-cache";
import { derivedMirrorsForPrimary } from "@/lib/pdns/topology-cache";
import { isWriteCapable } from "@/lib/pdns/capabilities";
import { redact } from "@/lib/errors/redact";
import { logger } from "@/lib/logger";

import type { PdnsServer } from "@/lib/db/schema";
import type { PdnsZoneDetail } from "@/lib/pdns/types";

export type SyncState =
  | "in-sync"
  | "ahead" // secondary's serial is somehow newer (rare; misconfig)
  | "lagging"
  | "missing"
  | "error";

export interface SecondarySyncStatus {
  server: PdnsServer;
  state: SyncState;
  primarySerial: number | null;
  secondarySerial: number | null;
  error: string | null;
}

interface MirrorBackend {
  server: PdnsServer;
  /** A member of the primary's group - the explicit-grouping fallback. */
  inGroup: boolean;
  /** Zone names this backend mirrors of `primary` (derived, from the cache). */
  derivedZones: Set<string>;
}

/**
 * The backends that mirror `primary`, read from caches (ADR-0014). The masters[]
 * derive is computed site-wide by the poller (lib/pdns/topology-cache); here we
 * just read it, union it with the primary's group members, and compare serials
 * from the zone-state cache - NO per-call PDNS fetch or DNS. A backend mirrors a
 * given zone if it's a group member OR the cached topology says its copy of that
 * zone points at this primary (so one secondary can mirror different primaries
 * per zone).
 */
async function discoverMirrors(primary: PdnsServer): Promise<MirrorBackend[]> {
  const [allBackends, groupSecondaries] = await Promise.all([
    listAllActiveBackends(),
    listSecondariesForPrimary(primary),
  ]);
  const byId = new Map(allBackends.map((b) => [b.id, b]));
  const groupIds = new Set(groupSecondaries.map((s) => s.id));
  const derivedBySecondary = derivedMirrorsForPrimary(primary.id);

  const out: MirrorBackend[] = [];
  for (const id of new Set([...groupIds, ...derivedBySecondary.keys()])) {
    if (id === primary.id) continue;
    const server = byId.get(id);
    if (!server) continue;
    out.push({
      server,
      inGroup: groupIds.has(id),
      derivedZones: derivedBySecondary.get(id) ?? new Set(),
    });
  }
  return out;
}

/** Does this mirror cover the primary's given zone (group member, or derived)? */
function mirrorsZone(m: MirrorBackend, zoneName: string): boolean {
  return m.inGroup || m.derivedZones.has(zoneName);
}

/** Serial-comparison status for one mirror's zone, read from the zone-state cache. */
function statusFromCache(
  m: MirrorBackend,
  zoneName: string,
  primarySerial: number | null,
): SecondarySyncStatus {
  const snap = readCachedZone(m.server.id, zoneName);
  if (!snap) {
    return {
      server: m.server,
      state: "missing",
      primarySerial,
      secondarySerial: null,
      error: null,
    };
  }
  const secondarySerial = snap.serial;
  let state: SyncState;
  if (primarySerial === null || secondarySerial === null) state = "error";
  else if (primarySerial === secondarySerial) state = "in-sync";
  else if (secondarySerial < primarySerial) state = "lagging";
  else state = "ahead";
  return { server: m.server, state, primarySerial, secondarySerial, error: null };
}

/**
 * Compare a zone's serial on a primary vs. each backend that mirrors it. Reads
 * mirror serials from the zone-state cache (poller-maintained) - the same source
 * the zones list uses, so the two never disagree. Doesn't fetch full rrsets -
 * that's `compareZoneRecords` below.
 */
export async function checkZoneSync(
  primary: PdnsServer,
  zoneName: string,
  primarySerial: number | null,
): Promise<SecondarySyncStatus[]> {
  const mirrors = await discoverMirrors(primary);
  return mirrors
    .filter((m) => mirrorsZone(m, zoneName))
    .map((m) => statusFromCache(m, zoneName, primarySerial));
}

/**
 * Site-wide rollup of mirror sync state - true when ANY group or derived mirror
 * of ANY managed primary isn't fully caught up to its primary's serial for at
 * least one zone. Reads exclusively from the in-process caches the poller
 * maintains (no PDNS calls, no DB write), so it's cheap enough to call from
 * the app shell on every page render.
 *
 * Used as the default mode for the header sync chip: pages that don't mount
 * their own `<HeaderStatusMode/>` (i.e. most non-zone pages) inherit this
 * single fleet-wide verdict. A return value of `false` covers both "every
 * mirror is in-sync" and "there are no mirrors to compare" - the chip stays
 * green in either case.
 *
 * Note on staleness: the chip is server-rendered, so the verdict only
 * refreshes on a layout re-execution (navigation or `router.refresh()`).
 * Pages that need sub-second reactivity push their own state via
 * `HeaderStatusMode` and a `useRealtimeEvent` listener.
 */
/**
 * True iff the fleet contains at least one cluster of ≥2 peers sharing zones -
 * a derived primary+secondaries group OR a configured multi-primary cluster.
 * Standalone servers and single primaries with zero secondaries do NOT
 * qualify; there's nothing to be "in sync" against.
 *
 * The app shell uses this to decide whether the header chip surfaces a
 * SYNCED/DESYNCED verdict at all - a fleet of standalones or single primaries
 * sees only the plain "Live" connectivity label, which is the truthful read
 * for that topology (issue #57 widened "no replication" to the common case).
 */
export async function hasReplicationTopology(): Promise<boolean> {
  const primaries = (await listAllActiveBackends()).filter((b) => isWriteCapable(b.capabilities));
  for (const primary of primaries) {
    const mirrors = await discoverMirrors(primary);
    if (mirrors.length > 0) return true;
  }
  return false;
}

export async function globalAnyLagging(): Promise<boolean> {
  const primaries = (await listAllActiveBackends()).filter((b) => isWriteCapable(b.capabilities));
  if (primaries.length === 0) return false;
  for (const primary of primaries) {
    const cached = readCachedZones(primary.id);
    if (!cached) continue;
    const zoneSerials = [...cached.zones.values()].map((z) => ({
      name: z.name,
      serial: z.serial,
    }));
    if (zoneSerials.length === 0) continue;
    const sync = await checkZonesSyncBatch(primary, zoneSerials);
    for (const statuses of sync.values()) {
      for (const s of statuses) {
        if (s.state !== "in-sync") return true;
      }
    }
  }
  return false;
}

/**
 * Batched variant for the zones-list page. Reads the mirror set + serials from
 * the caches (poller-maintained) - no per-zone PDNS calls. Returns a Map keyed
 * by zone name; zones absent from the map have no mirror (render "-").
 */
export async function checkZonesSyncBatch(
  primary: PdnsServer,
  zones: ReadonlyArray<{ name: string; serial: number | null }>,
): Promise<Map<string, SecondarySyncStatus[]>> {
  const mirrors = await discoverMirrors(primary);
  if (mirrors.length === 0 || zones.length === 0) return new Map();

  const out = new Map<string, SecondarySyncStatus[]>();
  for (const z of zones) {
    const relevant = mirrors.filter((m) => mirrorsZone(m, z.name));
    if (relevant.length === 0) continue;
    out.set(
      z.name,
      relevant.map((m) => statusFromCache(m, z.name, z.serial)),
    );
  }
  return out;
}

/**
 * Detail-level rrset diff between primary's zone and each secondary's.
 * Pulls full zones in parallel. Use sparingly - full-zone GETs are the
 * most expensive PDNS call we make.
 */
export interface SecondaryRrsetDiff {
  server: PdnsServer;
  primarySerial: number | null;
  secondarySerial: number | null;
  /** Lines present on primary but not secondary. */
  onlyOnPrimary: string[];
  /** Lines present on secondary but not primary. */
  onlyOnSecondary: string[];
  error: string | null;
}

export async function compareZoneRecords(
  primary: PdnsServer,
  primaryZone: PdnsZoneDetail,
): Promise<SecondaryRrsetDiff[]> {
  const mirrors = await discoverMirrors(primary);
  const relevant = mirrors.filter((m) => mirrorsZone(m, primaryZone.name));
  if (relevant.length === 0) return [];

  return Promise.all(relevant.map((m) => probeRrsetDiff(m.server, primaryZone)));
}

async function probeRrsetDiff(
  s: PdnsServer,
  primaryZone: PdnsZoneDetail,
): Promise<SecondaryRrsetDiff> {
  try {
    const client = getBackendGateway(s);
    const secondaryZone = await client.getZone(primaryZone.name);
    const primaryLines = rrsetsToCanonicalLines(primaryZone.rrsets ?? []);
    const secondaryLines = rrsetsToCanonicalLines(secondaryZone.rrsets ?? []);
    const primarySet = new Set(primaryLines);
    const secondarySet = new Set(secondaryLines);
    return {
      server: s,
      primarySerial: primaryZone.serial ?? null,
      secondarySerial: secondaryZone.serial ?? null,
      onlyOnPrimary: primaryLines.filter((l) => !secondarySet.has(l)),
      onlyOnSecondary: secondaryLines.filter((l) => !primarySet.has(l)),
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? redact(err.message) : "unknown";
    logger.warn(
      { server: s.slug, zone: primaryZone.name, error: message },
      "pdns.sync.records.failed",
    );
    return {
      server: s,
      primarySerial: primaryZone.serial ?? null,
      secondarySerial: null,
      onlyOnPrimary: [],
      onlyOnSecondary: [],
      error: message,
    };
  }
}

function rrsetsToCanonicalLines(
  rrsets: ReadonlyArray<{
    name: string;
    type: string;
    ttl: number;
    records: ReadonlyArray<{ content: string; disabled?: boolean }>;
  }>,
): string[] {
  const lines: string[] = [];
  for (const rr of rrsets) {
    for (const r of rr.records) {
      const prefix = r.disabled ? "; DISABLED " : "";
      const content = canonicalContentForCompare(rr.type, r.content);
      lines.push(`${prefix}${rr.name}\t${rr.ttl}\tIN\t${rr.type}\t${content}`);
    }
  }
  return lines.sort();
}

/**
 * Normalize a record's content so cross-peer comparison is by *meaning*,
 * not presentation. The case that bites us is TXT/SPF: the same value can
 * arrive as one long quoted string from one peer and as several adjacent
 * 255-octet character-strings from another (PDNS re-chunks on AXFR), which
 * a raw string compare flags as a spurious diff. Concatenating the
 * character-strings collapses both forms to the same key. Every other RR
 * type already has a single canonical presentation from PDNS, so it passes
 * through untouched.
 */
function canonicalContentForCompare(type: string, content: string): string {
  const t = type.toUpperCase();
  if (t === "TXT" || t === "SPF") return canonicalTxtContent(content);
  return content;
}

/**
 * Cluster-flavored equivalent of `compareZoneRecords`. For a multi-
 * primary cluster the operator-facing question is the same - "are all
 * peers serving identical content?" - so the diff shape is identical
 * (`SecondaryRrsetDiff`), but the "primary" anchor is the peer with
 * the highest serial. That's the closest we can get to a deterministic
 * source-of-truth without explicit conflict resolution: any peer with
 * a lower serial (or content drift) is highlighted as out-of-sync.
 *
 * The anchor peer itself is omitted from the returned list - the
 * comparison is N–1 entries deep, one per non-anchor peer, mirroring
 * how the primary+secondaries flow shows one entry per secondary.
 */
export async function compareClusterPeerRecords(
  peers: readonly PdnsServer[],
  zoneName: string,
): Promise<{ anchor: PdnsServer; diffs: SecondaryRrsetDiff[] }> {
  if (peers.length === 0) {
    throw new Error("compareClusterPeerRecords called with no peers");
  }

  // Fetch every peer's view of the zone in parallel so a slow peer
  // doesn't serialize the whole probe.
  const fetched = await Promise.all(
    peers.map(async (p) => {
      try {
        const client = getBackendGateway(p);
        const zone = await client.getZone(zoneName);
        return { peer: p, zone, error: null as string | null };
      } catch (err) {
        return {
          peer: p,
          zone: null as PdnsZoneDetail | null,
          error: err instanceof Error ? redact(err.message) : "unknown",
        };
      }
    }),
  );

  // Source-of-truth pick: highest serial wins. Ties broken by name to
  // keep render order stable across requests. Peers with errors / no
  // zone never become the anchor (we'd have nothing to compare against).
  const candidates = fetched.filter((f) => f.zone !== null);
  if (candidates.length === 0) {
    // Every peer errored - no anchor possible. Surface as an entry per
    // peer (excluding the first one to keep the shape) with their
    // error.
    const anchor = peers[0]!;
    return {
      anchor,
      diffs: peers.slice(1).map((p) => ({
        server: p,
        primarySerial: null,
        secondarySerial: null,
        onlyOnPrimary: [],
        onlyOnSecondary: [],
        error: "every peer is unreachable",
      })),
    };
  }
  candidates.sort((a, b) => {
    const sa = a.zone!.serial ?? -1;
    const sb = b.zone!.serial ?? -1;
    if (sa !== sb) return sb - sa;
    return a.peer.name.localeCompare(b.peer.name);
  });
  const anchorEntry = candidates[0]!;
  const anchor = anchorEntry.peer;
  const anchorLines = rrsetsToCanonicalLines(anchorEntry.zone!.rrsets ?? []);
  const anchorSet = new Set(anchorLines);
  const anchorSerial = anchorEntry.zone!.serial ?? null;

  const diffs: SecondaryRrsetDiff[] = [];
  for (const f of fetched) {
    if (f.peer.id === anchor.id) continue;
    if (f.error !== null || f.zone === null) {
      diffs.push({
        server: f.peer,
        primarySerial: anchorSerial,
        secondarySerial: null,
        onlyOnPrimary: [],
        onlyOnSecondary: [],
        error: f.error ?? "no zone returned",
      });
      continue;
    }
    const peerLines = rrsetsToCanonicalLines(f.zone.rrsets ?? []);
    const peerSet = new Set(peerLines);
    diffs.push({
      server: f.peer,
      primarySerial: anchorSerial,
      secondarySerial: f.zone.serial ?? null,
      onlyOnPrimary: anchorLines.filter((l) => !peerSet.has(l)),
      onlyOnSecondary: peerLines.filter((l) => !anchorSet.has(l)),
      error: null,
    });
  }
  return { anchor, diffs };
}
