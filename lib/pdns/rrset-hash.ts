/**
 * lib/pdns/rrset-hash.ts
 *
 * Structural hash for an RRset's content, used by ADR 0010
 * (per-RRset optimistic concurrency for the editor). Pure function:
 * no DB, no PDNS HTTP, no React. Lives in `lib/pdns/` because the
 * RRset shape is a PDNS concept.
 *
 * The hash is deterministic over canonical RRset content:
 *
 *   1. `name` lowercased - PDNS is case-insensitive at the DNS level
 *      but the API surface preserves the casing the operator sent.
 *      Two operators editing `Foo.example.` vs `foo.example.` must
 *      produce the same hash.
 *   2. `type` uppercased - PDNS canonicalizes type codes upper.
 *   3. `ttl` as-is - distinct TTLs are distinct rrsets.
 *   4. `records` sorted by (content, disabled) lexicographically -
 *      record order is not semantically meaningful for an RRset.
 *      `disabled` is normalized to a concrete boolean (false when
 *      absent) so two operators sending equivalent records - one
 *      with `{content, disabled: false}` and one with `{content}`
 *      - collide correctly.
 *
 * Output is the first 16 hex chars of SHA-256 (64 bits). For
 * optimistic concurrency among a handful of concurrent operators
 * (not adversaries), 64 bits is comfortably more than enough - at
 * 1000 concurrent rrset edits the birthday-paradox collision
 * probability is ~3e-14.
 */

import { createHash } from "node:crypto";

/**
 * Minimum RRset shape needed for hashing. Kept structural rather
 * than importing `RRsetPatch` from `./rrsets` so callers from
 * either client (zone-detail load) or server (PDNS round-trip) paths
 * can use this without coupling to the patch-builder type.
 */
export interface HashableRRset {
  name: string;
  type: string;
  ttl: number;
  records: ReadonlyArray<{ content: string; disabled?: boolean }>;
}

/**
 * Compute the structural hash of an RRset. Two RRsets that differ
 * only in case (name), record order, or implicit-vs-explicit
 * `disabled: false` produce the same hash.
 */
export function rrsetHash(rrset: HashableRRset): string {
  const canonical = JSON.stringify({
    name: rrset.name.toLowerCase(),
    type: rrset.type.toUpperCase(),
    ttl: rrset.ttl,
    records: [...rrset.records]
      .map((r) => ({ content: r.content, disabled: r.disabled === true }))
      .sort((a, b) => {
        // Primary sort by content; tie-break by disabled flag so the
        // (rare) case of identical content with different disabled
        // states is still deterministic.
        if (a.content !== b.content) return a.content.localeCompare(b.content);
        return a.disabled === b.disabled ? 0 : a.disabled ? 1 : -1;
      }),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** Shape of a single ADR 0010 conflict report. */
export interface RRsetConflict {
  rrsetName: string;
  rrsetType: string;
  reason: "modified" | "deleted";
  /** Present only when `reason === "modified"`. */
  currentHash?: string;
}

/** Per-change input the conflict detector cares about - only the
 * identifying triple plus the operator-supplied expected hash. */
export interface ConflictCandidate {
  name: string;
  type: string;
  expected?: { hash: string };
}

/**
 * Compute the ADR 0010 conflict list for a batch of changes against
 * the live zone snapshot. Pure: no DB, no PDNS, no logging - the
 * route wraps with auth + 409 response + audit. Pulled out for
 * direct unit testing (the route handler itself has no precedent
 * for unit-test mocking in this project).
 *
 * - Changes WITHOUT `expected` are skipped (legacy last-write-wins).
 * - Changes whose live rrset is absent → conflict with reason
 *   "deleted".
 * - Changes whose live rrset hashes to a different value → conflict
 *   with reason "modified" carrying the current hash so the client
 *   can render a diff.
 *
 * `beforeMap` is keyed by `${name}|${type}` matching the route's
 * existing convention.
 */
export function detectRRsetConflicts(
  changes: readonly ConflictCandidate[],
  beforeMap: ReadonlyMap<string, HashableRRset>,
): RRsetConflict[] {
  const conflicts: RRsetConflict[] = [];
  for (const change of changes) {
    if (!change.expected) continue;
    const live = beforeMap.get(`${change.name}|${change.type}`);
    if (!live) {
      conflicts.push({
        rrsetName: change.name,
        rrsetType: change.type,
        reason: "deleted",
      });
      continue;
    }
    const liveHash = rrsetHash(live);
    if (liveHash !== change.expected.hash) {
      conflicts.push({
        rrsetName: change.name,
        rrsetType: change.type,
        reason: "modified",
        currentHash: liveHash,
      });
    }
  }
  return conflicts;
}
