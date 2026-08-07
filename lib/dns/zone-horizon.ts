/**
 * lib/dns/zone-horizon.ts
 *
 * A zone's HORIZON - which audience it is served to. Split-horizon DNS is
 * ordinary practice: the same name answers one way on the internet and another
 * way inside the network, from two different daemons. The app has no way to
 * tell those two zones apart on its own (they are identical by name, and the
 * internal one is frequently a real public name), so the operator classifies
 * them and everything downstream keys off that.
 *
 * Only the deviation from the default is ever stored - a zone with no
 * classification is `public`, which keeps the table sparse and means no
 * backfill for the zones that already exist. The type is an open enum rather
 * than a boolean so a third horizon (a DMZ / partner view) can be added without
 * a migration and without rewriting every call site's `if (internal)`.
 *
 * Pure + dependency-free, so the DB schema, the route handlers, the server
 * components, and the client components can all share one vocabulary.
 * ADR-0022.
 */

/** Which audience a zone is served to. */
export type ZoneHorizon = "public" | "internal";

/** Every legal horizon, for validators and UI. */
export const ZONE_HORIZONS = ["public", "internal"] as const satisfies readonly ZoneHorizon[];

/**
 * The horizon a zone has when the operator hasn't classified it. Public: the
 * app has always listed zones as if they were internet-facing, so treating an
 * unclassified zone as anything else would silently reclassify every existing
 * install's fleet.
 */
export const DEFAULT_ZONE_HORIZON: ZoneHorizon = "public";

export function isZoneHorizon(value: unknown): value is ZoneHorizon {
  return value === "public" || value === "internal";
}

/** Narrow an untrusted / legacy value to a horizon, falling back to the default. */
export function toZoneHorizon(value: unknown): ZoneHorizon {
  return isZoneHorizon(value) ? value : DEFAULT_ZONE_HORIZON;
}

/** Operator-facing label. Uppercased at the badge call sites, not here. */
export function zoneHorizonLabel(horizon: ZoneHorizon): string {
  return horizon === "internal" ? "internal" : "public";
}
