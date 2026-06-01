/**
 * lib/pdns/topology-cache.ts
 *
 * Site-wide derived replication topology (ADR-0014), computed ONCE per poll
 * cycle by the zone-poller and read by every surface (servers list, zones list,
 * zone detail, sync, realtime). The derive - matching each mirror zone's
 * masters[] against backends' advertised addresses, with DNS resolution - is
 * expensive, so it lives in the poller, not in each page render.
 *
 * State lives on `globalThis`, NOT a plain module-level binding. Next.js's
 * standalone production build bundles server code per route, so a module `let`
 * would give the poller and each page render SEPARATE copies - the poller would
 * write a topology the pages never see (the bug that made every surface read
 * empty). Every read and write goes through `globalThis` so all bundles in the
 * process share one object (same survives-duplication pattern as the zone-state
 * cache). Empty until the first poll; consumers degrade to group-only behavior
 * meanwhile.
 */

import "server-only";

export interface DerivedTopology {
  /** `${primaryId} ${zoneName}` -> secondary backend ids mirroring it. */
  mirrorsByPrimaryZone: Map<string, Set<string>>;
  /**
   * secondaryId -> its representative upstream primary id (the one most of its
   * mirror zones point at). Drives the servers-list parent->child tree for
   * ungrouped secondaries.
   */
  parentBySecondary: Map<string, string>;
  computedAt: number;
}

declare global {
  var __pdnsDerivedTopology: DerivedTopology | undefined;
}

/** The single shared topology object, read fresh from globalThis every call. */
function current(): DerivedTopology {
  return (globalThis.__pdnsDerivedTopology ??= {
    mirrorsByPrimaryZone: new Map(),
    parentBySecondary: new Map(),
    computedAt: 0,
  });
}

const key = (primaryId: string, zoneName: string): string => `${primaryId} ${zoneName}`;

/** Replace the derived topology - called by the poller each cycle. */
export function writeDerivedTopology(next: DerivedTopology): void {
  globalThis.__pdnsDerivedTopology = next;
}

/** Secondary backend ids that mirror a primary's specific zone (derived). */
export function derivedMirrorsFor(primaryId: string, zoneName: string): ReadonlySet<string> {
  return current().mirrorsByPrimaryZone.get(key(primaryId, zoneName)) ?? EMPTY;
}

/** Whether ANY zone mirrors this primary (cheap "is this a derived parent?" check). */
export function hasDerivedMirrors(primaryId: string): boolean {
  for (const k of current().mirrorsByPrimaryZone.keys()) {
    if (k.startsWith(`${primaryId} `)) return true;
  }
  return false;
}

/** The representative upstream primary a secondary mirrors, if any. */
export function derivedParentOf(secondaryId: string): string | null {
  return current().parentBySecondary.get(secondaryId) ?? null;
}

/** For a primary: secondaryId → the set of its zone names that mirror this primary. */
export function derivedMirrorsForPrimary(primaryId: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const prefix = `${primaryId} `;
  for (const [k, secIds] of current().mirrorsByPrimaryZone) {
    if (!k.startsWith(prefix)) continue;
    const zoneName = k.slice(prefix.length);
    for (const secId of secIds) {
      let zset = out.get(secId);
      if (!zset) {
        zset = new Set();
        out.set(secId, zset);
      }
      zset.add(zoneName);
    }
  }
  return out;
}

/** For a mirror zone on a secondary: the upstream primary id it derives from. */
export function derivedUpstreamFor(secondaryId: string, zoneName: string): string | null {
  const suffix = ` ${zoneName}`;
  for (const [k, secIds] of current().mirrorsByPrimaryZone) {
    if (k.endsWith(suffix) && secIds.has(secondaryId)) {
      return k.slice(0, k.length - suffix.length);
    }
  }
  return null;
}

export function rawDerivedTopology(): DerivedTopology {
  return current();
}

const EMPTY: ReadonlySet<string> = new Set();
