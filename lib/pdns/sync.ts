/**
 * lib/pdns/sync.ts
 *
 * Helpers to compare a zone's state across a primary and its secondaries
 * — used by the zones list (compact "in-sync / lagging" column) and the
 * zone detail page (rrset diff panel).
 *
 * All probes run concurrently; per-secondary errors are caught and
 * surfaced as `state="error"` so one unreachable mirror doesn't break
 * the rest of the view.
 */

/* eslint-disable no-restricted-imports -- Sanctioned lib/pdns→lib/db bridge:
   this module is cross-server zone-state coordination — it enumerates a
   primary's active secondaries (a DB read) and fans probes across them. See
   ADR-0013. Future work: relocate above lib/pdns (e.g. a lib/cluster/ module). */
import "server-only";
import { listActiveSecondariesForPrimary } from "@/lib/db/repositories/pdns-servers";
import { canonicalTxtContent } from "@/lib/dns/txt";
import { getPdnsClientForRow } from "@/lib/pdns/registry";
import { PdnsNotFoundError } from "@/lib/pdns/errors";
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

/**
 * Compare a zone's serial on a primary vs. each of its active secondaries.
 * Doesn't fetch full rrsets — that's `compareZoneRecords` below.
 */
export async function checkZoneSync(
  primary: PdnsServer,
  zoneName: string,
  primarySerial: number | null,
): Promise<SecondarySyncStatus[]> {
  const secondaries = await listActiveSecondariesForPrimary(primary.id);
  if (secondaries.length === 0) return [];

  return Promise.all(secondaries.map(async (s) => probeSecondary(s, zoneName, primarySerial)));
}

async function probeSecondary(
  s: PdnsServer,
  zoneName: string,
  primarySerial: number | null,
): Promise<SecondarySyncStatus> {
  try {
    const client = getPdnsClientForRow(s);
    // Plain getZone — the `?rrsets=false` summary fetch was returning
    // stale/buggy serials on some PDNS versions (chip stuck on
    // "syncing" with the Sync tab body simultaneously showing IN SYNC).
    // The full fetch costs us bandwidth but is the source-of-truth.
    const zone = await client.getZone(zoneName);
    const secondarySerial = zone.serial ?? null;
    let state: SyncState;
    if (primarySerial === null || secondarySerial === null) state = "error";
    else if (primarySerial === secondarySerial) state = "in-sync";
    else if (secondarySerial < primarySerial) state = "lagging";
    else state = "ahead";
    return {
      server: s,
      state,
      primarySerial,
      secondarySerial,
      error: null,
    };
  } catch (err) {
    if (err instanceof PdnsNotFoundError) {
      return {
        server: s,
        state: "missing",
        primarySerial,
        secondarySerial: null,
        error: null,
      };
    }
    const message = err instanceof Error ? redact(err.message) : "unknown";
    logger.warn({ server: s.slug, zone: zoneName, error: message }, "pdns.sync.probe.failed");
    return {
      server: s,
      state: "error",
      primarySerial,
      secondarySerial: null,
      error: message,
    };
  }
}

/**
 * Batched variant for the zones-list page. Probes every secondary for
 * every zone — cap at concurrency=8 per secondary so a long zone list
 * doesn't open hundreds of sockets at once.
 *
 * Returns a Map keyed by zone name; value is the per-secondary sync
 * statuses. Zones absent from the map indicate "no secondaries
 * configured" (nothing to compare).
 */
export async function checkZonesSyncBatch(
  primary: PdnsServer,
  zones: ReadonlyArray<{ name: string; serial: number | null }>,
): Promise<Map<string, SecondarySyncStatus[]>> {
  const secondaries = await listActiveSecondariesForPrimary(primary.id);
  if (secondaries.length === 0 || zones.length === 0) return new Map();

  // For each secondary, fetch the whole zone list once. Way cheaper
  // than per-zone GET /zones/{id} N×M times.
  const secondaryZoneMaps = await Promise.all(
    secondaries.map(async (s) => {
      try {
        const client = getPdnsClientForRow(s);
        const list = await client.listZones();
        const m = new Map<string, number | null>();
        for (const z of list) m.set(z.name, z.serial ?? null);
        return { server: s, map: m, error: null as string | null };
      } catch (err) {
        const message = err instanceof Error ? redact(err.message) : "unknown";
        logger.warn({ server: s.slug, error: message }, "pdns.sync.list.failed");
        return {
          server: s,
          map: new Map<string, number | null>(),
          error: message,
        };
      }
    }),
  );

  const out = new Map<string, SecondarySyncStatus[]>();
  for (const z of zones) {
    const entries: SecondarySyncStatus[] = [];
    for (const sm of secondaryZoneMaps) {
      if (sm.error !== null) {
        entries.push({
          server: sm.server,
          state: "error",
          primarySerial: z.serial,
          secondarySerial: null,
          error: sm.error,
        });
        continue;
      }
      if (!sm.map.has(z.name)) {
        entries.push({
          server: sm.server,
          state: "missing",
          primarySerial: z.serial,
          secondarySerial: null,
          error: null,
        });
        continue;
      }
      const secondarySerial = sm.map.get(z.name) ?? null;
      let state: SyncState;
      if (z.serial === null || secondarySerial === null) state = "error";
      else if (secondarySerial === z.serial) state = "in-sync";
      else if (secondarySerial < z.serial) state = "lagging";
      else state = "ahead";
      entries.push({
        server: sm.server,
        state,
        primarySerial: z.serial,
        secondarySerial,
        error: null,
      });
    }
    out.set(z.name, entries);
  }
  return out;
}

/**
 * Detail-level rrset diff between primary's zone and each secondary's.
 * Pulls full zones in parallel. Use sparingly — full-zone GETs are the
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
  const secondaries = await listActiveSecondariesForPrimary(primary.id);
  if (secondaries.length === 0) return [];

  return Promise.all(secondaries.map(async (s) => probeRrsetDiff(s, primaryZone)));
}

async function probeRrsetDiff(
  s: PdnsServer,
  primaryZone: PdnsZoneDetail,
): Promise<SecondaryRrsetDiff> {
  try {
    const client = getPdnsClientForRow(s);
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
 * primary cluster the operator-facing question is the same — "are all
 * peers serving identical content?" — so the diff shape is identical
 * (`SecondaryRrsetDiff`), but the "primary" anchor is the peer with
 * the highest serial. That's the closest we can get to a deterministic
 * source-of-truth without explicit conflict resolution: any peer with
 * a lower serial (or content drift) is highlighted as out-of-sync.
 *
 * The anchor peer itself is omitted from the returned list — the
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
        const client = getPdnsClientForRow(p);
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
    // Every peer errored — no anchor possible. Surface as an entry per
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
