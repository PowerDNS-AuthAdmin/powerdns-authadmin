/**
 * lib/health/replicated-keys.ts
 *
 * Pure cross-backend TSIG missing-key detection (ADR-0015), factored out of the
 * poller so it can be unit-tested without any I/O. The poller gathers each
 * backend's `GET /tsigkeys` listing and its primary→secondaries topology, then
 * calls this.
 *
 * The "replicated set" for a group = keys present on the primary AND on at least
 * one of its secondaries — i.e. keys the operator actually pushed to the group
 * (the install flow pushes to all). A secondary missing any of those has drifted
 * (the canonical case: a replicated key deleted off one secondary). Primary-only
 * keys (never replicated) are deliberately NOT flagged, so a key kept solely on
 * the primary is fine.
 */

export interface SecondaryKeyListing {
  id: string;
  /** Enumerated key names, or null when not enumerated (unreachable / old
   *  version / listing failed) — a null secondary is skipped, never flagged. */
  names: readonly string[] | null;
}

/**
 * How many replicated keys each secondary is MISSING. Only secondaries with a
 * positive count appear in the map.
 */
export function missingReplicatedKeys(
  primaryNames: readonly string[] | null,
  secondaries: readonly SecondaryKeyListing[],
): Map<string, number> {
  const out = new Map<string, number>();
  if (!primaryNames || primaryNames.length === 0 || secondaries.length === 0) return out;

  const onAnySecondary = new Set<string>();
  for (const s of secondaries) for (const n of s.names ?? []) onAnySecondary.add(n);
  const replicated = primaryNames.filter((n) => onAnySecondary.has(n));
  if (replicated.length === 0) return out;

  for (const s of secondaries) {
    if (!s.names) continue; // not enumerated → don't flag
    const have = new Set(s.names);
    const missing = replicated.filter((k) => !have.has(k)).length;
    if (missing > 0) out.set(s.id, missing);
  }
  return out;
}
