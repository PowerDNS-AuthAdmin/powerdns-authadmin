/**
 * components/domain/ptr-review.ts
 *
 * The before/after PTR RRsets a Reverse DNS rectify run will produce, per
 * reverse zone, for the review dialog's BIND-style diff. Pure: it mirrors
 * what `POST /api/admin/pdns/auto-ptr/rectify` does with each item so the
 * operator sees the change before it is sent, without a dry-run round trip.
 *
 *   set    - the PTR RRset becomes exactly one record naming the target, at
 *            the item's TTL (the route's default when the item has none).
 *   remove - only the records naming the target go; the rest of a
 *            multi-target RRset stays at its current TTL, and an RRset left
 *            empty is deleted.
 */

/** The rectify route's TTL for a `set` item that carries none. */
export const RECTIFY_DEFAULT_TTL = 3600;

export interface PtrReviewInput {
  /** Reverse owner name, e.g. `1.2.0.192.in-addr.arpa.`. */
  owner: string;
  reverseZone: string | null;
  currentTargets: readonly string[];
  currentTtl: number | null;
  action: "set" | "remove";
  target: string;
  ttl?: number;
}

/** Shape `computeBindDiff` takes. */
export interface PtrReviewRRset {
  name: string;
  type: "PTR";
  ttl: number;
  records: Array<{ content: string }>;
}

export interface PtrReviewZone {
  reverseZone: string;
  /** Addresses this run touches in the zone. */
  addresses: number;
  before: PtrReviewRRset[];
  after: PtrReviewRRset[];
}

const NO_REVERSE_ZONE = "(no reverse zone)";

function absolute(name: string): string {
  const lower = name.trim().toLowerCase();
  return lower.endsWith(".") ? lower : `${lower}.`;
}

function rrset(owner: string, ttl: number, targets: readonly string[]): PtrReviewRRset {
  return {
    name: absolute(owner),
    type: "PTR",
    ttl,
    records: targets.map((content) => ({ content: absolute(content) })),
  };
}

/**
 * Group rectify items by reverse zone (alphabetical) with the PTR RRsets
 * before and after each item is applied.
 */
export function buildPtrReview(items: readonly PtrReviewInput[]): PtrReviewZone[] {
  const zones = new Map<string, PtrReviewZone>();
  for (const item of items) {
    const zoneName = item.reverseZone ?? NO_REVERSE_ZONE;
    let zone = zones.get(zoneName);
    if (!zone) {
      zone = { reverseZone: zoneName, addresses: 0, before: [], after: [] };
      zones.set(zoneName, zone);
    }
    zone.addresses++;
    const currentTtl = item.currentTtl ?? RECTIFY_DEFAULT_TTL;
    if (item.currentTargets.length > 0) {
      zone.before.push(rrset(item.owner, currentTtl, item.currentTargets));
    }
    if (item.action === "set") {
      zone.after.push(rrset(item.owner, item.ttl ?? RECTIFY_DEFAULT_TTL, [item.target]));
      continue;
    }
    const target = absolute(item.target);
    const remaining = item.currentTargets.filter((t) => absolute(t) !== target);
    if (remaining.length > 0) zone.after.push(rrset(item.owner, currentTtl, remaining));
  }
  return [...zones.values()].sort((a, b) => a.reverseZone.localeCompare(b.reverseZone));
}
