/**
 * lib/pdns/catalog.ts
 *
 * Catalog zones (RFC 9432) read off one backend's zone list. A Producer
 * zone's members are the zones whose `catalog` field names it; PowerDNS keeps
 * no other record of the membership, so it is one pass over the list a page
 * or the poller already holds.
 *
 * Pure and import-light so the poller, the health evaluator's callers, route
 * handlers and the zones list can share it.
 */

import { canonicalZoneName } from "@/lib/dns/zone-name";
import { catalogRole, isSystemKind } from "./zone-kinds";

export interface CatalogZoneLike {
  name: string;
  kind: string;
  /** The catalog this zone is a member of; null/empty when none. */
  catalog?: string | null;
}

/** Member count per catalog name (canonical), for every catalog any zone names. */
export function catalogMemberCounts(zones: readonly CatalogZoneLike[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const z of zones) {
    if (!z.catalog) continue;
    const name = canonicalZoneName(z.catalog);
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

/** The zones naming `catalog` as theirs, by canonical name, sorted. */
export function catalogMembers(zones: readonly CatalogZoneLike[], catalog: string): string[] {
  const target = canonicalZoneName(catalog);
  return zones
    .filter((z) => z.catalog && canonicalZoneName(z.catalog) === target)
    .map((z) => canonicalZoneName(z.name))
    .sort();
}

/** Producer zones on the backend, canonical and sorted - the choices for a zone's catalog. */
export function producerZoneNames(zones: readonly CatalogZoneLike[]): string[] {
  return zones
    .filter((z) => catalogRole(z.kind) === "producer")
    .map((z) => canonicalZoneName(z.name))
    .sort();
}

export interface CatalogHealthInputs {
  /** Catalogs member zones name that no catalog zone on the backend answers to. */
  orphanedCatalogs: Array<{ catalog: string; members: number }>;
  /** `default-catalog-zone` naming a zone that is missing or isn't a Producer. */
  defaultCatalogProblem: { name: string; problem: "missing" | "not-producer" } | null;
}

/**
 * What the health evaluator needs to know about catalogs on one backend. A
 * member's catalog counts as present when a Producer or Consumer zone of that
 * name exists (on a consumer, members name the Consumer zone).
 */
export function catalogHealthInputs(
  zones: readonly CatalogZoneLike[],
  defaultCatalogZone: string | undefined,
): CatalogHealthInputs {
  const kindByName = new Map(zones.map((z) => [canonicalZoneName(z.name), z.kind]));
  const orphanedCatalogs = [...catalogMemberCounts(zones)]
    .filter(([catalog]) => !isSystemKind(kindByName.get(catalog) ?? ""))
    .map(([catalog, members]) => ({ catalog, members }))
    .sort((a, b) => a.catalog.localeCompare(b.catalog));

  let defaultCatalogProblem: CatalogHealthInputs["defaultCatalogProblem"] = null;
  if (defaultCatalogZone) {
    const name = canonicalZoneName(defaultCatalogZone);
    const kind = kindByName.get(name);
    if (kind === undefined) defaultCatalogProblem = { name, problem: "missing" };
    else if (catalogRole(kind) !== "producer") {
      defaultCatalogProblem = { name, problem: "not-producer" };
    }
  }
  return { orphanedCatalogs, defaultCatalogProblem };
}
