/**
 * lib/dns/zone-dedupe.ts
 *
 * Collapse the amalgamated fleet zone list to one row per zone IDENTITY.
 *
 * The same zone surfaces from several backends at once - a primary plus its
 * mirrors, two primaries seeded with the same name, two secondaries of one
 * external primary - and the list is meant to show it once, resolved to the
 * backend that actually owns it.
 *
 * Identity is `(horizon, name)`, not `name` alone (ADR-0022). A zone the
 * operator marked `internal` is a different zone from the public one that
 * happens to share its name: different backend, different records, different
 * audience. Keying on the name alone made the internal copy vanish into the
 * "duplicate zones hidden" notice, which described a deliberate split-horizon
 * setup as an accident of replication (#121). Two copies on the SAME horizon
 * still collapse - that really is replication, or a genuine name collision.
 *
 * Pure, so the rule is unit-testable away from the page that renders it.
 */

import { type ZoneHorizon } from "./zone-horizon";

/** The subset of a zone row this module reasons about. */
export interface DedupableZoneRow {
  /** Canonical zone name (lowercase, trailing dot). */
  name: string;
  /** Which audience this copy serves. */
  horizon: ZoneHorizon;
  /** True when the row is a read-only mirror rather than an authoritative copy. */
  readOnly?: boolean;
}

/**
 * Identity key for a row - the two facts that make two copies the same zone.
 * JSON-encoded rather than string-joined so no separator has to be argued
 * about: distinct `(horizon, name)` pairs cannot produce the same key.
 */
export function zoneIdentityKey(row: DedupableZoneRow): string {
  return JSON.stringify([row.horizon, row.name]);
}

/**
 * One row per `(horizon, name)`. An authoritative (writable) row always beats a
 * read-only mirror of the same identity; among rows of the same tier the first
 * wins (rows arrive in a stable, name-ordered backend sequence). Net: a zone
 * resolves to its primary, or - if none is managed - to the first secondary
 * that serves it.
 *
 * `Map` preserves first-insertion order, so replacing a displaced row in place
 * keeps its original position in the list.
 */
export function dedupeZonesByIdentity<T extends DedupableZoneRow>(
  rows: readonly T[],
): { kept: T[]; hidden: T[] } {
  const byIdentity = new Map<string, T>();
  const hidden: T[] = [];
  for (const row of rows) {
    const key = zoneIdentityKey(row);
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, row);
      continue;
    }
    // Prefer an authoritative row over a read-only mirror; the displaced one is
    // hidden. Otherwise this duplicate is the one hidden.
    if (existing.readOnly && !row.readOnly) {
      byIdentity.set(key, row);
      hidden.push(existing);
    } else {
      hidden.push(row);
    }
  }
  return { kept: [...byIdentity.values()], hidden };
}
