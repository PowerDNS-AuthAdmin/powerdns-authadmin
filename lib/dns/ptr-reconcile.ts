/**
 * lib/dns/ptr-reconcile.ts
 *
 * The fleet-wide reverse-DNS diff behind the Reverse DNS page: every A/AAAA
 * record the installation serves, side by side with the PTR that exists for
 * its address in the reverse zones hosted here. One row per address, so an
 * operator can see at a glance which hosts have no reverse name, which point
 * at a stale one, which addresses several names compete for, and which PTRs
 * nothing points at any more.
 *
 * Pure: the route gathers the records from every backend and asks this module
 * what they mean; the page renders the rows; rectification goes through the
 * same auto-PTR planner the record editor uses, so a fix here is exactly the
 * write a save would have made.
 */

import { findReverseZone, ipFromReverseOwner, parseIp } from "./reverse-name";
import type { ZoneHorizon } from "./zone-horizon";

export interface ForwardAddressRecord {
  zone: string;
  server: string;
  /** The forward zone's horizon; only reverse zones of the same horizon are consulted. */
  horizon: ZoneHorizon;
  name: string;
  type: "A" | "AAAA";
  ttl: number;
  disabled: boolean;
  content: string;
}

/** One PTR RRset as it exists on a hosted reverse zone. */
export interface ReversePtrRecord {
  zone: string;
  server: string;
  horizon: ZoneHorizon;
  owner: string;
  ttl: number;
  targets: string[];
}

export interface HostedReverseZoneInfo {
  name: string;
  server: string;
  writable: boolean;
  /**
   * Effective horizon: the operator's classification, else "internal" when the
   * zone covers private address space (RFC 1918, ULA), else "public". A public
   * forward record never matches an internal reverse zone and vice versa, so a
   * split-horizon install keeps its two reverse trees apart.
   */
  horizon: ZoneHorizon;
}

export type PtrReconcileStatus =
  | "ok"
  | "missing"
  | "mismatch"
  | "ambiguous"
  | "orphan"
  | "unhosted";

export interface PtrReconcileRow {
  id: string;
  ip: string;
  family: 4 | 6;
  horizon: ZoneHorizon;
  owner: string;
  reverseZone: string | null;
  reverseServer: string | null;
  forward: Array<Omit<ForwardAddressRecord, "content">>;
  currentTargets: string[];
  currentTtl: number | null;
  status: PtrReconcileStatus;
  suggestedTarget: string | null;
  canWrite: boolean;
}

export interface PtrReconcileStats {
  ok: number;
  missing: number;
  mismatch: number;
  ambiguous: number;
  orphan: number;
  unhosted: number;
}

export interface PtrReconcileInput {
  forward: readonly ForwardAddressRecord[];
  reverse: readonly ReversePtrRecord[];
  hostedReverseZones: readonly HostedReverseZoneInfo[];
  /** Whether the caller may write records in (zone, server). */
  canWriteReverse: (zone: string, server: string) => boolean;
}

const lower = (s: string): string => s.toLowerCase();

/**
 * Pick the backend a reverse zone is written on: a writable copy first, then
 * any copy (so the row still shows what the PTR says even when nobody here
 * can change it).
 */
function hostOf(
  zone: string,
  hosted: readonly HostedReverseZoneInfo[],
  horizon: ZoneHorizon,
): HostedReverseZoneInfo | null {
  const copies = hosted.filter((h) => h.name === zone && h.horizon === horizon);
  return copies.find((h) => h.writable) ?? copies[0] ?? null;
}

export function reconcilePtrs(input: PtrReconcileInput): {
  rows: PtrReconcileRow[];
  stats: PtrReconcileStats;
} {
  const hostedByHorizon = (horizon: ZoneHorizon): string[] => [
    ...new Set(input.hostedReverseZones.filter((h) => h.horizon === horizon).map((h) => h.name)),
  ];
  const reverseByKey = new Map<string, ReversePtrRecord>();
  for (const r of input.reverse) reverseByKey.set(`${r.server}|${r.zone}|${lower(r.owner)}`, r);

  // Group forward records by canonical address.
  // Grouped by horizon as well as address: the same address can legitimately
  // carry different names on each side of a split horizon.
  const groups = new Map<
    string,
    { ip: string; family: 4 | 6; horizon: ZoneHorizon; records: ForwardAddressRecord[] }
  >();
  for (const rec of input.forward) {
    const parsed = parseIp(rec.content);
    if (!parsed) continue;
    const key = `${rec.horizon}:${parsed.family}:${parsed.canonical}`;
    const g = groups.get(key) ?? {
      ip: rec.content.trim(),
      family: parsed.family,
      horizon: rec.horizon,
      records: [],
    };
    g.records.push(rec);
    groups.set(key, g);
  }

  const rows: PtrReconcileRow[] = [];
  const claimedOwners = new Set<string>();
  for (const [key, g] of groups) {
    const match = findReverseZone(g.ip, hostedByHorizon(g.horizon));
    const owner = match?.owner ?? null;
    const host = match ? hostOf(match.zone, input.hostedReverseZones, g.horizon) : null;
    const current =
      match && host
        ? reverseByKey.get(`${host.server}|${match.zone}|${lower(match.owner)}`)
        : undefined;
    if (match) claimedOwners.add(`${g.horizon}|${match.zone}|${lower(match.owner)}`);

    const names = [...new Set(g.records.map((r) => lower(r.name)))].sort();
    const targets = current ? current.targets.map(lower) : [];
    let status: PtrReconcileStatus;
    let suggested: string | null = null;
    if (!match || !host) {
      status = "unhosted";
    } else if (targets.length === 1 && names.includes(targets[0]!)) {
      status = "ok";
      suggested = targets[0]!;
    } else if (names.length > 1) {
      status = "ambiguous";
      suggested = targets.find((t) => names.includes(t)) ?? names[0]!;
    } else {
      status = targets.length === 0 ? "missing" : "mismatch";
      suggested = names[0]!;
    }

    rows.push({
      id: key,
      ip: g.ip,
      family: g.family,
      horizon: g.horizon,
      owner: owner ?? "",
      reverseZone: match?.zone ?? null,
      reverseServer: host?.server ?? null,
      forward: g.records
        .map(({ content: _content, ...rest }) => rest)
        .sort((a, b) => a.name.localeCompare(b.name) || a.zone.localeCompare(b.zone)),
      currentTargets: current ? [...current.targets] : [],
      currentTtl: current?.ttl ?? null,
      status,
      suggestedTarget: suggested,
      canWrite:
        match && host ? host.writable && input.canWriteReverse(match.zone, host.server) : false,
    });
  }

  // PTRs nothing points at: reverse records whose owner no forward address claimed.
  for (const r of input.reverse) {
    if (r.targets.length === 0) continue;
    if (claimedOwners.has(`${r.horizon}|${r.zone}|${lower(r.owner)}`)) continue;
    const ip = ipFromReverseOwner(r.owner);
    if (!ip) continue; // apex, delegation or otherwise not an address
    const parsed = parseIp(ip);
    const host = hostOf(r.zone, input.hostedReverseZones, r.horizon);
    rows.push({
      id: `orphan:${r.server}|${r.zone}|${lower(r.owner)}`,
      ip,
      family: parsed?.family ?? 4,
      horizon: r.horizon,
      owner: lower(r.owner),
      reverseZone: r.zone,
      reverseServer: host?.server ?? r.server,
      forward: [],
      currentTargets: [...r.targets],
      currentTtl: r.ttl,
      status: "orphan",
      suggestedTarget: null,
      canWrite: host ? host.writable && input.canWriteReverse(r.zone, host.server) : false,
    });
  }

  const order: Record<PtrReconcileStatus, number> = {
    mismatch: 0,
    missing: 1,
    ambiguous: 2,
    orphan: 3,
    unhosted: 4,
    ok: 5,
  };
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] || a.ip.localeCompare(b.ip, undefined, { numeric: true }),
  );

  const stats: PtrReconcileStats = {
    ok: 0,
    missing: 0,
    mismatch: 0,
    ambiguous: 0,
    orphan: 0,
    unhosted: 0,
  };
  for (const row of rows) stats[row.status]++;
  return { rows, stats };
}
