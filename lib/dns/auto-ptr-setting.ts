/**
 * lib/dns/auto-ptr-setting.ts
 *
 * Whether saving an A/AAAA record also maintains its PTR. Resolution order,
 * most specific first:
 *
 *   1. the change itself (`ptr: true|false` on the RRset PATCH / MCP call /
 *      the editor's checkbox)
 *   2. the zone's `X-AUTHADMIN-AUTO-PTR` metadata (`on` | `off`)
 *   3. the `auto_ptr` app setting (global, admin Settings / YAML)
 *   4. off
 *
 * Off by default: an install upgrading to this version must not start
 * writing into reverse zones because an operator saved a record, and a
 * reverse zone that is hosted here is not necessarily one that should mirror
 * every forward zone. The per-zone value lives in PowerDNS metadata for the
 * same reason the default TTL does (`lib/dns/default-ttl.ts`): it travels with
 * the zone and is written through the metadata route's permission check and
 * audit row.
 *
 * Pure and dependency-free so server components, route handlers and client
 * components share one parser.
 */

/** Custom PowerDNS metadata kind holding a zone's auto-PTR override. */
export const ZONE_AUTO_PTR_KIND = "X-AUTHADMIN-AUTO-PTR";

/** The canonical spellings the metadata value is normalised to. */
export const ZONE_AUTO_PTR_VALUES = ["on", "off"] as const;

export type AutoPtrSource = "change" | "zone" | "global" | "builtin";

export interface ResolvedAutoPtr {
  enabled: boolean;
  source: AutoPtrSource;
}

/** Parse a stored flag; null when it isn't a recognisable on/off spelling. */
export function parseAutoPtrFlag(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (v === "on" || v === "yes" || v === "true" || v === "1") return true;
  if (v === "off" || v === "no" || v === "false" || v === "0") return false;
  return null;
}

/**
 * The zone's override from its metadata list, or null when unset. A value
 * hand-set to garbage on the PowerDNS host is ignored rather than surfaced as
 * an error - the zone falls back to the global setting.
 */
export function zoneAutoPtrFromMetadata(
  metadata: ReadonlyArray<{ kind: string; metadata: readonly string[] }>,
): boolean | null {
  const entry = metadata.find((m) => m.kind === ZONE_AUTO_PTR_KIND);
  const first = entry?.metadata[0];
  return first === undefined ? null : parseAutoPtrFlag(first);
}

export function resolveAutoPtr(input: {
  change?: boolean | null | undefined;
  zone: boolean | null;
  global: boolean | null;
}): ResolvedAutoPtr {
  if (typeof input.change === "boolean") return { enabled: input.change, source: "change" };
  if (input.zone !== null) return { enabled: input.zone, source: "zone" };
  if (input.global !== null) return { enabled: input.global, source: "global" };
  return { enabled: false, source: "builtin" };
}

/**
 * Validation error for a write of the per-zone kind, or null when the values
 * are acceptable. Exactly one on/off value: PowerDNS stores metadata as a
 * string list, so without this a typo would be saved and silently ignored.
 */
export function zoneAutoPtrValuesError(values: readonly string[]): string | null {
  if (values.length !== 1 || parseAutoPtrFlag(values[0]!) === null) {
    return `${ZONE_AUTO_PTR_KIND} takes a single value: on or off.`;
  }
  return null;
}

/** The stored spelling for a parsed flag. */
export function autoPtrFlagValue(enabled: boolean): (typeof ZONE_AUTO_PTR_VALUES)[number] {
  return enabled ? "on" : "off";
}
